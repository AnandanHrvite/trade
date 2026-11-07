/**
 * ORB OFFLINE SIMULATION CORE
 * ─────────────────────────────────────────────────────────────────────────────
 * The day loop, cost model and stats block that scripts/orbValidate.js used to
 * carry inline. Extracted 2026-08-11 so scripts/orbSweep.js can compare configs
 * against EXACTLY the same simulation — a second hand-written copy would make
 * every sweep result incomparable with the validation numbers, which is how the
 * "+346 spot points, no losers" era happened.
 *
 * It drives the real getSignal() and the shipped exit engine (orbExits — whose
 * only rule since 2026-11-07 is the global profit lock), simulated on a
 * δ-modelled premium exactly as src/routes/orbBacktest.js
 * does, with anything still open closed at the day's last candle (paper's
 * TRADE_STOP_TIME session teardown). It writes nothing and places no orders.
 *
 * All ORB_* tuning is read from process.env by the engine itself, so a caller
 * sweeps configs by setting env keys and calling simulate() again.
 */

const path = require("path");
const orb = require(path.join(__dirname, "../../src/strategies/orb_breakout"));
const orbExits = require(path.join(__dirname, "../../src/strategies/orbExits"));
const tradeGuards = require(path.join(__dirname, "../../src/utils/tradeGuards"));

const r2 = x => Math.round(x * 100) / 100;
const DAY = t => Math.floor((t + 19800) / 86400);
const MIN = t => Math.floor((t + 19800) / 60) % 1440;
const DATE = t => new Date((t + 19800) * 1000).toISOString().slice(0, 10);

// ── Cost model: keep it pessimistic. Spot points flatter a strategy whose exits
//    cluster at breakeven, because a 0-point scratch is still a real rupee loss.
//    Read lazily (not at require time) so a sweep can vary the lot size / delta.
const THETA = 2.5;   // premium pts, typical intraday hold
const CHARGE = 60;   // INR round trip
function costModel() {
  const qty = parseInt(process.env.NIFTY_LOT_SIZE || "65", 10) * parseInt(process.env.LOT_MULTIPLIER || "1", 10);
  const delta = parseFloat(process.env.BACKTEST_DELTA || "0.6");
  const slip = parseFloat(process.env.ORB_BT_SLIPPAGE_PTS || "1.5");   // premium pts EACH way
  return { qty, delta, slip, theta: THETA, charge: CHARGE, toINR: pts => r2((delta * pts - 2 * slip - THETA) * qty - CHARGE) };
}

function stats(list) {
  if (!list.length) return null;
  const w = list.filter(t => t.inr > 0), l = list.filter(t => t.inr <= 0);
  const net = r2(list.reduce((a, t) => a + t.inr, 0));
  const gp = w.reduce((a, t) => a + t.inr, 0), gl = Math.abs(l.reduce((a, t) => a + t.inr, 0));
  return {
    n: list.length, net, exp: r2(net / list.length),
    wr: r2(w.length / list.length * 100), pf: gl ? r2(gp / gl) : Infinity,
    avgWin: w.length ? r2(gp / w.length) : 0, avgLoss: l.length ? r2(-gl / l.length) : 0,
    worst: Math.min(...list.map(t => t.inr)), best: Math.max(...list.map(t => t.inr)),
  };
}

/**
 * Walk every session once and return the trades ORB would have taken.
 *
 * @param {Array} candles  time-ordered 5-min candles covering the whole range.
 * @returns {{trades: Array, sessions: number}}
 */
function simulate(candles) {
  const { toINR, delta } = costModel();
  // Premium model for the lock — the same δ model and seed the backtest route uses.
  const SEED = parseFloat(process.env.ORB_BT_SEED_PREMIUM || "240");
  const premAt = (side, entry, spot) => Math.max(0.05, SEED + (side === "CE" ? spot - entry : entry - spot) * delta);
  const spotForPrem = (side, entry, prem) => {
    const move = delta > 0 ? (prem - SEED) / delta : 0;
    return side === "CE" ? entry + move : entry - move;
  };
  // Wait-after-any-exit cooldown (EXIT_REENTRY_COOLDOWN_CANDLES), in unix seconds.
  const COOLDOWN = tradeGuards.reentryCooldownMs(5) / 1000;
  const IDX = new Map(candles.map((c, i) => [c.time, i]));
  const DAYS = [...new Set(candles.map(c => DAY(c.time)))].sort((a, b) => a - b);

  const trades = [];
  for (const d of DAYS) {
    const dayC = candles.filter(c => DAY(c.time) === d);
    let blockUntil = 0;
    for (let j = 0; j < dayC.length; j++) {
      if (blockUntil && dayC[j].time < blockUntil) continue;
      const gi = IDX.get(dayC[j].time);
      const win = candles.slice(Math.max(0, gi - 199), gi + 1);
      const sig = orb.getSignal(win, { silent: true });
      if (sig.signal === "NONE") continue;

      const bar = dayC[j], side = sig.side, entry = bar.close;
      // ── Exit model: the profit lock only. A bar is replayed as open → adverse
      //    extreme → favourable extreme → close (the conservative path), as in the
      //    backtest route: a lock tripped on the way down fills at its floor's spot
      //    level (never better than the open); one armed and given back inside the
      //    bar fills at the close. A trade the lock never closes ends at the day's
      //    last candle close.
      // The same position shape and per-tick decision paper/live run.
      const pos = { isFutures: false, side, optionEntryLtp: SEED, peakPremium: SEED };
      const lock = prem => orbExits.evaluateTickExits(pos, { optionLtp: prem }).exit;
      let exit = null, why = null, mae = 0, mfe = 0, exitIdx = dayC.length - 1, exitClock = null;
      for (let k = j + 1; k < dayC.length; k++) {
        const c = dayC[k];
        exitIdx = k;
        const fav = side === "CE" ? c.high - entry : entry - c.low;
        const adv = side === "CE" ? entry - c.low : c.high - entry;
        mfe = Math.max(mfe, fav); mae = Math.max(mae, adv);

        const pOpen = premAt(side, entry, c.open);
        if (pOpen > pos.peakPremium) pos.peakPremium = pOpen;
        if (lock(pOpen)) { exit = c.open; why = "lock"; exitClock = c.time; break; }
        if (lock(premAt(side, entry, side === "CE" ? c.low : c.high))) {
          const floor = tradeGuards.profitLockFloorLtp(SEED, pos.peakPremium, tradeGuards.PROFIT_LOCK_FLOOR_PCT, tradeGuards.PROFIT_LOCK_TRAIL_PCT);
          const raw = spotForPrem(side, entry, floor);
          exit = side === "CE" ? Math.min(c.open, raw) : Math.max(c.open, raw);
          why = "lock"; exitClock = c.time; break;
        }
        const pFav = premAt(side, entry, side === "CE" ? c.high : c.low);
        if (pFav > pos.peakPremium) pos.peakPremium = pFav;
        if (lock(premAt(side, entry, c.close))) { exit = c.close; why = "lock"; exitClock = c.time + 5 * 60; break; }
      }
      if (exit == null) {
        const rest = dayC.slice(j + 1);
        exit = (rest[rest.length - 1] || bar).close;
        why = "EOD";
      }

      const pts = r2(side === "CE" ? exit - entry : entry - exit);
      // atr5 comes from the SIGNAL, not a second hand-rolled ATR — a local
      // ATR.calculate() here would re-introduce the overnight-gap contamination
      // orb_breakout._atrAtLast() fixes (2026-08-04), so the regime buckets would be
      // sliced on a yardstick the engine no longer uses.
      trades.push({
        date: DATE(bar.time), time: MIN(bar.time), side, pts, inr: toINR(pts), why,
        mae: r2(mae), mfe: r2(mfe),
        orPts: sig.rangePts, gap: sig.gapPts, atr5: sig.atr5,
        orAtr: sig.atr15 ? r2(sig.rangePts / sig.atr15) : null,
      });
      if (why === "EOD") break;               // the session is over
      // Resume the hunt from the EXIT bar, behind the wait-after-exit cooldown.
      if (COOLDOWN > 0) blockUntil = exitClock + COOLDOWN;
      j = exitIdx;
    }
  }
  return { trades, sessions: DAYS.length };
}

module.exports = { simulate, stats, costModel, r2 };

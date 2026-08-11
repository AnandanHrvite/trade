/**
 * ORB OFFLINE SIMULATION CORE
 * ─────────────────────────────────────────────────────────────────────────────
 * The day loop, cost model and stats block that scripts/orbValidate.js used to
 * carry inline. Extracted 2026-08-11 so scripts/orbSweep.js can compare configs
 * against EXACTLY the same simulation — a second hand-written copy would make
 * every sweep result incomparable with the validation numbers, which is how the
 * "+346 spot points, no losers" era happened.
 *
 * It drives the real getSignal() plus the shipped exit engine (orbExits) and the
 * real stop resolver (orbStopRisk). It writes nothing and places no orders.
 *
 * All ORB_* tuning is read from process.env by the engine itself, so a caller
 * sweeps configs by setting env keys and calling simulate() again.
 */

const path = require("path");
const orb = require(path.join(__dirname, "../../src/strategies/orb_breakout"));
const orbExits = require(path.join(__dirname, "../../src/strategies/orbExits"));
const orbStopRisk = require(path.join(__dirname, "../../src/utils/orbStopRisk"));

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
  const { toINR, qty } = costModel();
  const IDX = new Map(candles.map((c, i) => [c.time, i]));
  const DAYS = [...new Set(candles.map(c => DAY(c.time)))].sort((a, b) => a - b);
  const EOD = (() => { const [h, m] = (process.env.ORB_FORCED_EXIT || "15:15").split(":").map(Number); return h * 60 + m; })();

  const trades = [];
  for (const d of DAYS) {
    const dayC = candles.filter(c => DAY(c.time) === d);
    for (let j = 0; j < dayC.length; j++) {
      const gi = IDX.get(dayC[j].time);
      const win = candles.slice(Math.max(0, gi - 199), gi + 1);
      const sig = orb.getSignal(win, { silent: true, alreadyTraded: false });
      if (sig.signal === "NONE") continue;

      const bar = dayC[j], side = sig.side, entry = bar.close;
      const st = orbStopRisk.resolveInitialStop({
        side, entrySpot: entry, strategyStop: sig.slSpot, qty,
        fallbackStop: side === "CE" ? sig.orl : sig.orh,
      });
      // ── Exit model. Driven by the SHARED exit engine (src/strategies/orbExits.js)
      //    — the same functions paper, live and the backtest route run, so the
      //    statistics this produces describe the shipped strategy rather than a
      //    fourth hand-written copy of it.
      //
      //    ORDER MIRRORS PAPER'S REAL TIMELINE:
      //      per TICK   (_checkExits)            → rupee cap / premium stop / hard SL
      //      per CLOSE  (_managePositionOnClose) → opposite candle → breakeven → EMA
      //    so intrabar exits get first refusal inside a candle and a close-based rule
      //    can only fire on a bar that never touched the stop. The rupee cap is
      //    already folded into the stop by orbStopRisk above (it clamps to the level
      //    ORB_MAX_TRADE_LOSS allows), so the spot SL here IS the cap.
      const pos = {
        side, entrySpot: entry, slSpot: st.slSpot,
        orh: sig.orh, orl: sig.orl, rangePts: sig.rangePts,
        breakevenArmed: false, emaArmed: false, lastEma: null,
      };
      let exit = null, why = null, mae = 0, mfe = 0;
      for (const c of dayC.slice(j + 1)) {
        // EOD squares off at the first tick at/after ORB_FORCED_EXIT — this bar's
        // OPEN, not the close of the last bar before it.
        if (MIN(c.time) >= EOD) { exit = c.open; why = "EOD"; break; }

        const fav = side === "CE" ? c.high - entry : entry - c.low;
        const adv = side === "CE" ? entry - c.low : c.high - entry;
        mfe = Math.max(mfe, fav); mae = Math.max(mae, adv);

        // 1. intrabar hard SL (gap-through fills at the open, as in paper/backtest)
        if (orbExits.isHardSlHit(side, side === "CE" ? c.low : c.high, pos.slSpot)) {
          exit = side === "CE" ? Math.min(pos.slSpot, c.open) : Math.max(pos.slSpot, c.open);
          why = pos.breakevenArmed ? "BE" : "SL"; break;
        }
        // 2-4. close: opposite candle → breakeven → EMA trail, from the shared engine.
        //      The EMA window is the same multi-day slice getSignal received, so the
        //      trail is seeded before the open exactly as paper's preload makes it.
        const ci = IDX.get(c.time);
        const dec = orbExits.evaluateCloseExits(pos, c, candles.slice(Math.max(0, ci - 199), ci + 1));
        if (dec.exit) {
          exit = c.close;
          why = /EMA/.test(dec.reason) ? "trail" : "opp";
          break;
        }
      }
      if (exit == null) { const rest = dayC.slice(j + 1); exit = (rest[rest.length - 1] || bar).close; why = "EOD"; }

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
        clamped: st.clamped,
      });
      break;
    }
  }
  return { trades, sessions: DAYS.length };
}

module.exports = { simulate, stats, costModel, r2, DAY, MIN, DATE };

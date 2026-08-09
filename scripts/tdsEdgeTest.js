#!/usr/bin/env node
/**
 * TREND_DAY_SCALP — DOES THE ENTRY PREDICT ANYTHING?
 * ─────────────────────────────────────────────────────────────────────────────
 * Two years of backtests put TREND_DAY_SCALP between profit factor 0.6 and 1.14
 * depending on which knob was turned, which is the signature of a strategy with
 * no edge rather than one that needs tuning. Turning knobs cannot answer that;
 * this can.
 *
 * THE TEST. Hold everything constant except the ONE thing being questioned —
 * the moment of entry. On exactly the same gate-passing days, with the same
 * locked side, the same stop rule, the same 2.5R target, the same exits and the
 * same costs, compare:
 *
 *     REAL     — enter where getSignal() says (pullback → reclaim → conviction)
 *     RANDOM   — enter on a randomly chosen eligible bar of the same day
 *
 * Repeat the random draw many times to build a distribution, then ask where the
 * real strategy falls inside it. If the pullback-and-reclaim rule carries
 * information, REAL should sit in the top tail. If it lands mid-pack, the entry
 * is noise and no stop/target/time-stop tuning will rescue it — the day gate and
 * the risk model would be doing all the work.
 *
 *   node scripts/tdsEdgeTest.js --from 2024-01-01 --to 2026-08-09
 *   node scripts/tdsEdgeTest.js --from 2025-01-01 --to 2025-12-31 --iters 500
 *
 * Requires a live Fyers token (~/trading-data/.fyers_token) — it pulls history
 * through the repo's own cached fetcher. It writes NOTHING and places NO orders.
 *
 * IT READS YOUR CURRENT SETTINGS. Whatever TDS_* values are live in .env are the
 * ones tested, so the result describes the config you are actually running.
 */

process.env.TZ = "Asia/Calcutta";
require("dotenv").config();

const path = require("path");
const tds = require(path.join(__dirname, "../src/strategies/trend_day_scalp"));
const { fetchCandlesCachedBT } = require(path.join(__dirname, "../src/services/backtestEngine"));
const { getCharges } = require(path.join(__dirname, "../src/utils/charges"));
const instrumentConfig = require(path.join(__dirname, "../src/config/instrument"));

const SYMBOL = "NSE:NIFTY50-INDEX";
const MIN = t => Math.floor((t + 19800) / 60) % 1440;

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

/**
 * Deterministic PRNG. Math.random() would make the run unreproducible, and a
 * result nobody can reproduce is not evidence. --seed changes the draw.
 */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── The production exit model, run over one day's bars from a given entry ─────
// Deliberately a copy of trendDayScalpBacktest's ordering (stop before target,
// gap fills at the open, breakeven arms off the bar extreme but can only be hit
// on a LATER bar) so REAL and RANDOM are scored by identical rules.
function simulate(bars, startIdx, side, entrySpot, slPts, cfg, cost) {
  const isCE = side === "CE";
  const dir = isCE ? 1 : -1;
  let slSpot = entrySpot - dir * slPts;
  const targetSpot = entrySpot + dir * cfg.targetR * slPts;
  let beArmed = false;
  const entryTime = bars[startIdx].time;
  const forcedExitMin = tds._parseHHMM(process.env.TDS_FORCED_EXIT, 15 * 60 + 10);

  // Theta is charged from the ACTUAL exit bar, not the last bar of the day — an
  // EOD exit at 15:10 must not be billed for the 15:25 bar it never held.
  const finish = (exitSpot, exitTime, reason) => {
    const barsHeld = Math.max(0, (exitTime - entryTime) / 60 / cfg.resolutionMins);
    return { pnl: cost(side, entrySpot, exitSpot, barsHeld), reason, riskPts: slPts };
  };

  for (let i = startIdx + 1; i < bars.length; i++) {
    const c = bars[i];
    if (MIN(c.time) >= forcedExitMin) return finish(c.open, c.time, "EOD");

    const stopTouched = isCE ? c.low <= slSpot : c.high >= slSpot;
    const tgtTouched  = isCE ? c.high >= targetSpot : c.low <= targetSpot;

    if (stopTouched) {
      const fill = isCE ? (c.open < slSpot ? c.open : slSpot) : (c.open > slSpot ? c.open : slSpot);
      const held = Math.max(0, (c.time - entryTime) / 60 / cfg.resolutionMins);
      return { pnl: cost(side, entrySpot, fill, held), reason: beArmed ? "BE stop" : "Stop", riskPts: slPts };
    }
    if (tgtTouched) {
      const fill = isCE ? (c.open > targetSpot ? c.open : targetSpot) : (c.open < targetSpot ? c.open : targetSpot);
      const held = Math.max(0, (c.time - entryTime) / 60 / cfg.resolutionMins);
      return { pnl: cost(side, entrySpot, fill, held), reason: "Target", riskPts: slPts };
    }
    if (!beArmed) {
      const fav = isCE ? c.high : c.low;
      const be = tds.breakevenJump(side, entrySpot, fav, slPts, cfg);
      if (be.armed && Number.isFinite(be.stop)) { beArmed = true; slSpot = be.stop; }
    }
    if (cfg.timeStopMins > 0 && !beArmed && (c.time - entryTime) >= cfg.timeStopMins * 60) {
      const held = Math.max(0, (c.time - entryTime) / 60 / cfg.resolutionMins);
      return { pnl: cost(side, entrySpot, c.close, held), reason: "Time stop", riskPts: slPts };
    }
  }
  const last = bars[bars.length - 1];
  return finish(last.close, last.time, "EOD (no more bars)");
}

function stats(trades) {
  const n = trades.length;
  if (!n) return { n: 0, net: 0, pf: 0, wr: 0, exp: 0 };
  const net = trades.reduce((s, t) => s + t.pnl, 0);
  const w = trades.filter(t => t.pnl > 0);
  const gp = w.reduce((s, t) => s + t.pnl, 0);
  const gl = -trades.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0);
  return { n, net, pf: gl > 0 ? gp / gl : Infinity, wr: (w.length / n) * 100, exp: net / n };
}

(async () => {
  const from  = arg("from", "2025-01-01");
  const to    = arg("to", "2026-08-09");
  // A malformed --iters/--seed must not degrade silently: parseInt("x") is NaN,
  // and mulberry32(NaN) quietly becomes seed 0, so a typo would look like a run.
  const iters = (v => Number.isFinite(v) && v > 0 ? v : 300)(parseInt(arg("iters", "300"), 10));
  const seed  = (v => Number.isFinite(v) ? v : 20260809)(parseInt(arg("seed", "20260809"), 10));
  if (String(arg("seed", "")) && !Number.isFinite(parseInt(arg("seed", "20260809"), 10))) {
    console.log(`--seed was not a number; using ${seed}`);
  }

  const cfg = tds.getConfig();
  const LOT = instrumentConfig.getLotQty();
  const DELTA = parseFloat(process.env.BACKTEST_DELTA || "0.55");
  const THETA = parseFloat(process.env.BACKTEST_THETA_DAY || "8");
  const SEEDP = parseFloat(process.env.TDS_BT_SEED_PREMIUM || "240");
  const SLIP  = parseFloat(process.env.TDS_BT_SLIPPAGE_PTS || "1.5");
  const barsPerDay = Math.max(1, Math.round(375 / cfg.resolutionMins));

  // Identical premium model for both arms — only the entry bar differs.
  const cost = (side, entrySpot, exitSpot, barsHeld) => {
    const move = side === "CE" ? exitSpot - entrySpot : entrySpot - exitSpot;
    const theta = (THETA * barsHeld) / barsPerDay;
    const raw = Math.max(0.05, SEEDP + move * DELTA - theta / LOT);
    const exitPrem = Math.max(0.05, raw - 2 * SLIP);
    const ch = getCharges({ broker: "fyers", isFutures: false, entryPremium: SEEDP, exitPremium: exitPrem, qty: LOT });
    return parseFloat(((exitPrem - SEEDP) * LOT - ch).toFixed(2));
  };

  console.log(`\nTREND_DAY_SCALP edge test — ${from} → ${to}`);
  console.log(`config under test: extension ${cfg.extensionMult}× · stop ${cfg.minSlPts}-${cfg.maxSlPts}pt · target ${cfg.targetR}R · time stop ${cfg.timeStopMins}m · BE +${cfg.breakevenR}R`);
  process.stdout.write("fetching candles… ");
  const raw = await fetchCandlesCachedBT(SYMBOL, String(cfg.resolutionMins), from, to, false, () => {});
  if (!Array.isArray(raw) || raw.length < 500) {
    console.log(`\n\nOnly ${raw ? raw.length : 0} candles came back. On EC2 this almost always means the Fyers token has expired — an expired token returns no data rather than an auth error. Log in to Fyers again and re-run.`);
    process.exit(1);
  }
  const all = raw.slice().sort((a, b) => a.time - b.time);
  console.log(`${all.length} bars\n`);

  // ── Group into days, keep only the ones the day gate passes ────────────────
  const byDay = new Map();
  for (let i = 0; i < all.length; i++) {
    const k = tds._istDayOf(all[i].time);
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(i);
  }

  const days = [];
  for (const [, idxs] of byDay) {
    const gPos = idxs.findIndex(i => MIN(all[i].time) === cfg.gateMin - cfg.resolutionMins);
    if (gPos < 0) continue;
    const gate = tds.evaluateDayGate(all.slice(0, idxs[gPos] + 1), { cfg, silent: true });
    if (!gate.tradeable) continue;

    // Bars eligible for an entry: after the gate, closing on or before the window end.
    const eligible = [];
    for (let p = gPos + 1; p < idxs.length; p++) {
      if (MIN(all[idxs[p]].time) + cfg.resolutionMins > cfg.entryEndMin) break;
      eligible.push(p);
    }
    if (eligible.length) days.push({ idxs, gate, gPos, eligible });
  }
  console.log(`gate-passing days with at least one eligible bar: ${days.length}\n`);
  if (!days.length) { console.log("Nothing to test."); process.exit(0); }

  // ── ARM 1: the real strategy ──────────────────────────────────────────────
  // Record WHICH days actually produced a trade — the random arm must use exactly
  // those days and no others.
  const realTrades = [];
  const tradedDays = [];
  for (const d of days) {
    const bars = d.idxs.map(i => all[i]);
    for (const p of d.eligible) {
      const sig = tds.getSignal(all.slice(0, d.idxs[p] + 1), { dayGate: d.gate, cfg, silent: true });
      if (sig.signal === "NONE" || !sig.side) continue;
      realTrades.push(simulate(bars, p, sig.side, sig.entrySpot, sig.slPts, cfg, cost));
      tradedDays.push(d);
      break;   // one trade per day in both arms, so the comparison is like-for-like
    }
  }
  console.log(`the real entry fired on ${tradedDays.length} of those ${days.length} days\n`);
  if (!tradedDays.length) { console.log("The entry never fires — nothing to compare."); process.exit(0); }

  // ── ARM 2: random entry on the SAME days, same rules ──────────────────────
  // Two things must be matched or the test is rigged. Same DAYS: comparing the
  // real arm's 6 trades against a random arm's 12 would punish the random arm for
  // nothing more than trading twice as often against a negative cost drag. Same
  // STOP RULE: the pullback extreme of the last N bars, floored and capped, so the
  // only thing that differs between the arms is the TIMING of the entry.
  const rand = mulberry32(seed);
  const randomNets = [], randomPfs = [];
  let skipped = 0;
  for (let it = 0; it < iters; it++) {
    const trades = [];
    for (const d of tradedDays) {
      const bars = d.idxs.map(i => all[i]);
      const side = d.gate.side;
      // Re-draw when the random bar's structural stop exceeds the cap — the engine
      // would have skipped it too, and silently dropping the day would leave the
      // arms with different trade counts again.
      let placed = false;
      for (let attempt = 0; attempt < 40 && !placed; attempt++) {
        const p = d.eligible[Math.floor(rand() * d.eligible.length)];
        const bar = bars[p];
        const win = [];
        for (let q = p; q >= 0 && win.length < cfg.pullbackWindow; q--) win.unshift(bars[q]);
        const struct = side === "CE"
          ? bar.close - Math.min(...win.map(c => c.low))
          : Math.max(...win.map(c => c.high)) - bar.close;
        if (struct > cfg.maxSlPts) continue;            // same skip rule as the engine
        const slPts = Math.max(struct, cfg.minSlPts);
        if (!(slPts > 0)) continue;
        trades.push(simulate(bars, p, side, bar.close, slPts, cfg, cost));
        placed = true;
      }
      if (!placed) skipped++;
    }
    const s = stats(trades);
    if (!s.n) continue;
    randomNets.push(s.net);
    randomPfs.push(s.pf === Infinity ? 99 : s.pf);
  }
  if (!randomNets.length) { console.log("No random draw produced a tradeable bar — cannot compare."); process.exit(1); }
  if (skipped) {
    const perDraw = skipped / iters;
    console.log(`(${perDraw.toFixed(2)} day(s) per draw had no bar inside the ${cfg.maxSlPts}pt stop cap after 40 tries — those days are absent from the random arm)\n`);
  }

  // ── Verdict ───────────────────────────────────────────────────────────────
  const R = stats(realTrades);
  randomNets.sort((a, b) => a - b);
  randomPfs.sort((a, b) => a - b);
  const q = (arr, p) => arr[Math.min(arr.length - 1, Math.floor(arr.length * p))];
  const beaten = randomNets.filter(x => x < R.net).length;
  const pct = (beaten / randomNets.length) * 100;

  console.log(`REAL   entries: ${R.n} trades · WR ${R.wr.toFixed(0)}% · PF ${R.pf.toFixed(2)} · net ₹${R.net.toFixed(0)} · ₹${R.exp.toFixed(0)}/trade`);
  console.log(`RANDOM entries: ${iters} draws on the SAME days, same stop/target/exits`);
  console.log(`   net   p5 ₹${q(randomNets,.05).toFixed(0)}  p25 ₹${q(randomNets,.25).toFixed(0)}  median ₹${q(randomNets,.5).toFixed(0)}  p75 ₹${q(randomNets,.75).toFixed(0)}  p95 ₹${q(randomNets,.95).toFixed(0)}`);
  console.log(`   PF    p5 ${q(randomPfs,.05).toFixed(2)}  median ${q(randomPfs,.5).toFixed(2)}  p95 ${q(randomPfs,.95).toFixed(2)}`);
  console.log(`\n   the real entry beats ${pct.toFixed(0)}% of random entries.\n`);

  if (pct >= 95)      console.log("   VERDICT: the entry carries real information. Worth paper trading.");
  else if (pct >= 80) console.log("   VERDICT: suggestive, not proven. More history before risking anything.");
  else if (pct >= 40) console.log("   VERDICT: the entry is NOISE. It performs like picking a bar at random on\n            the same days — the day gate and the risk model are doing all the\n            work. No stop/target/time-stop tuning will fix this; the entry rule\n            itself has to change or the strategy should be retired.");
  else                console.log("   VERDICT: the entry is WORSE than random. It is actively selecting bad bars —\n            most likely buying exhaustion at the end of a move rather than a\n            continuation. Retire it or invert the premise.");

  console.log(`\n(seed ${seed}; re-run with --seed N to confirm the draw is not the story)`);
})();

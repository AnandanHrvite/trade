#!/usr/bin/env node
/**
 * ORB CONFIG SWEEP — with a forced out-of-sample split
 * ─────────────────────────────────────────────────────────────────────────────
 *   node scripts/orbSweep.js --from 2024-01-01 --to 2026-08-11
 *   node scripts/orbSweep.js --from 2024-01-01 --to 2026-08-11 --split 2026-01-01
 *
 * Runs a short list of NAMED hypotheses (not a grid) through the same simulation
 * scripts/orbValidate.js publishes — see scripts/lib/orbSim.js — and prints each
 * one on TRAIN and TEST separately. The split defaults to the 70% point of the
 * date range; --split pins it to a date.
 *
 * WHY THE SPLIT IS NOT OPTIONAL. Every ORB filter tightened so far "improves"
 * every metric in-sample, because it drops scratch-cost trades while the 2-3
 * outlier winners survive at any threshold. That is the sample selecting itself.
 * A variant is only interesting if it holds on TEST, which it never saw.
 *
 * READ THE OUTPUT LIKE THIS:
 *   - TEST net decides. TRAIN net is how the variant was chosen, so it is biased up.
 *   - A variant with n<30 on TEST proves nothing either way.
 *   - Ignore any variant whose profit is one trade (the `best%` column).
 *
 * Requires a Fyers token for uncached months (~/trading-data/.fyers_token); fully
 * cached ranges run offline. Writes nothing, places no orders.
 */

process.env.TZ = "Asia/Calcutta";
require("dotenv").config();

const path = require("path");
const { fetchCandlesCachedBT } = require(path.join(__dirname, "../src/services/backtestEngine"));
const { simulate, stats, costModel, r2 } = require(path.join(__dirname, "lib/orbSim"));

const SYMBOL = "NSE:NIFTY50-INDEX";

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

/**
 * The hypotheses. Each is a set of ORB_* overrides applied on top of the current
 * .env; anything not named keeps its shipped value. Keep this list SHORT and
 * motivated — a 200-cell grid over one sample is curve-fitting with extra steps.
 */
const VARIANTS = [
  { name: "baseline (shipped)",      env: {} },
  { name: "rescan OFF (pre-08-11)",  env: { ORB_BREAKOUT_RESCAN: "false" } },
  // OR width — the only cut that held across the 2025 and 2026 samples.
  { name: "OR cap 85pt",             env: { ORB_OR_MAX_PTS: "85" } },
  { name: "OR cap 70pt",             env: { ORB_OR_MAX_PTS: "70" } },
  { name: "OR cap 60pt",             env: { ORB_OR_MAX_PTS: "60" } },
  { name: "OR/ATR15 <= 1.5",         env: { ORB_OR_ATR_MAX: "1.5" } },
  // Entry quality / timing.
  { name: "body >= 0.8xATR5",        env: { ORB_BODY_ATR_MULT: "0.8" } },
  { name: "entry cut-off 10:30",     env: { ORB_ENTRY_END: "10:30" } },
  { name: "confirmed only (no retest)", env: { ORB_RETEST_MAX_WAIT: "0" } },
  // Exit side — half the losses are the rupee cap firing, and the EMA trail is
  // the only exit bucket that ever makes money.
  { name: "trail EMA34",             env: { ORB_TRAIL_EMA: "34" } },
  { name: "max trade loss 2500",     env: { ORB_MAX_TRADE_LOSS: "2500" } },
  { name: "no opposite-candle exit", env: { ORB_OPP_CANDLE_EXIT: "false" } },
  // ── Exits, 2026-08-13. On the 2025 (n=123) and 2026 (n=60) exports the trail is
  //    where the bleed lives: a long tail of −₹200…−₹1,200 EMA exits, each also
  //    paying ~₹420 of spread + theta, against 3 outsized winners that carry the
  //    whole gross profit. ORB needs a ~40% win rate to break even at its avg
  //    win/loss and gets 20%, so the question is whether the trail is cutting
  //    trades that would have become winners, or correctly killing dead ones.
  //    These separate the two. TEST decides — see the header.
  { name: "trail arms at +15pt",     env: { ORB_TRAIL_ARM_PTS: "15" } },
  { name: "trail arms at +25pt",     env: { ORB_TRAIL_ARM_PTS: "25" } },
  { name: "trail arms at +40pt",     env: { ORB_TRAIL_ARM_PTS: "40" } },
  { name: "trail needs 2 closes",    env: { ORB_TRAIL_CONFIRM_CLOSES: "2" } },
  { name: "arm +25pt + 2 closes",    env: { ORB_TRAIL_ARM_PTS: "25", ORB_TRAIL_CONFIRM_CLOSES: "2" } },
  { name: "arm +25pt + EMA34",       env: { ORB_TRAIL_ARM_PTS: "25", ORB_TRAIL_EMA: "34" } },
  { name: "arm +25 + 2cl + EMA34",   env: { ORB_TRAIL_ARM_PTS: "25", ORB_TRAIL_CONFIRM_CLOSES: "2", ORB_TRAIL_EMA: "34" } },
  // The combination worth knowing about, if the parts hold on TEST.
  { name: "OR cap 70 + EMA34",       env: { ORB_OR_MAX_PTS: "70", ORB_TRAIL_EMA: "34" } },
];

function cell(s, trades) {
  if (!s) return "     n=0                                     ";
  const best = s.net > 0 ? r2(s.best / s.net * 100) : 0;
  return `n=${String(s.n).padStart(3)} WR=${String(s.wr).padStart(4)}% net=${String(Math.round(s.net)).padStart(7)} PF=${String(s.pf === Infinity ? "inf" : s.pf.toFixed(2)).padStart(5)} best=${String(Math.round(best)).padStart(4)}%`;
}

(async () => {
  const from = arg("from", "2024-01-01");
  const to = arg("to", new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }));

  console.log(`\nORB config sweep  ${from} → ${to}`);
  const cost = costModel();
  console.log(`cost model: qty ${cost.qty}, delta ${cost.delta}, slippage ${cost.slip}pt/side, theta ${cost.theta}pt, charges ₹${cost.charge} — a 0-point scratch costs ${cost.toINR(0)} INR\n`);

  let candles;
  try {
    candles = await fetchCandlesCachedBT(SYMBOL, "5", from, to, false, m => process.stdout.write(`\r${typeof m === "string" ? m : m.phase || ""}   `));
    process.stdout.write("\r");
  } catch (e) {
    console.error(`\nFetch failed: ${e.message}`);
    console.error(`Usually an expired Fyers token — log in at /auth/login, then re-run.`);
    process.exit(1);
  }
  if (!candles || candles.length < 500) {
    console.error(`Only ${candles ? candles.length : 0} candles returned. An expired token returns no_data (0 candles), not an auth error — re-login and retry.`);
    process.exit(1);
  }
  candles.sort((a, b) => a.time - b.time);

  // Split by DATE so a session is never cut in half.
  const dates = [...new Set(candles.map(c => new Date((c.time + 19800) * 1000).toISOString().slice(0, 10)))].sort();
  const split = arg("split", dates[Math.floor(dates.length * 0.7)]);
  console.log(`${candles.length} candles, ${dates.length} sessions — TRAIN ${dates[0]}…${split} | TEST ${split}…${dates[dates.length - 1]}\n`);

  // Snapshot the keys a variant may touch, so each run starts from the same base
  // and a variant can never inherit the previous one's overrides.
  const KEYS = [...new Set(VARIANTS.flatMap(v => Object.keys(v.env)))];
  const BASE = Object.fromEntries(KEYS.map(k => [k, process.env[k]]));
  const restore = () => KEYS.forEach(k => { if (BASE[k] === undefined) delete process.env[k]; else process.env[k] = BASE[k]; });

  const header = `${"variant".padEnd(30)} ${"TRAIN".padEnd(45)} TEST`;
  console.log(header);
  console.log("─".repeat(header.length + 10));

  const results = [];
  for (const v of VARIANTS) {
    restore();
    Object.assign(process.env, v.env);
    const { trades } = simulate(candles);
    const train = trades.filter(t => t.date < split);
    const test = trades.filter(t => t.date >= split);
    const sTr = stats(train), sTe = stats(test);
    results.push({ name: v.name, sTr, sTe });
    console.log(`${v.name.padEnd(30)} ${cell(sTr, train).padEnd(45)} ${cell(sTe, test)}`);
  }
  restore();

  console.log(`\n${"═".repeat(110)}`);
  const winners = results.filter(r => r.sTe && r.sTe.net > 0 && r.sTe.n >= 30);
  if (!winners.length) {
    console.log("NOTHING survives: no variant is profitable on TEST with at least 30 trades.");
    console.log("That is a result — it says ORB has no edge at these settings, not that the sweep needs more variants.");
  } else {
    console.log("Profitable on TEST with n>=30 (still check the best% column — one trade is not an edge):");
    for (const r of winners.sort((a, b) => b.sTe.net - a.sTe.net)) {
      console.log(`  ${r.name.padEnd(30)} TEST net=${Math.round(r.sTe.net)}  PF=${r.sTe.pf}  n=${r.sTe.n}`);
    }
  }
  console.log(`${"═".repeat(110)}`);
  console.log(`Next: re-run the winner through scripts/orbValidate.js for the bootstrap CI and P(edge <= 0)`);
  console.log(`before changing any default. A variant that wins here has still only been seen once.\n`);
})();

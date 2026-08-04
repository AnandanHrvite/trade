#!/usr/bin/env node
/**
 * ORB LONG-SAMPLE VALIDATION
 * ─────────────────────────────────────────────────────────────────────────────
 * The 2026-07-26 rebuild was selected on 39 sessions (Mar–Apr 2026) — far too few
 * to establish an edge. Bootstrap on that sample put a ~25% probability on the
 * true edge being zero or negative, and reaching 95% confidence / 80% power needs
 * roughly 147 trades ≈ 637 sessions. This script runs that validation the moment
 * enough history is reachable, so the blocker is one command rather than a
 * research project:
 *
 *   node scripts/orbValidate.js --from 2024-01-01 --to 2026-04-30
 *
 * Requires a live Fyers token (~/trading-data/.fyers_token) because it pulls
 * historical candles through the repo's own cached fetcher. It writes NOTHING and
 * places NO orders — it drives the real getSignal() and the production exit model
 * offline.
 *
 * WHAT IT REPORTS — deliberately the things that kill a small-sample conclusion:
 *   • net / expectancy / profit factor IN RUPEES with costs, not spot points
 *   • bootstrap 95% CI on mean-per-trade and P(edge ≤ 0)
 *   • concentration: how much of the profit is the single best trade
 *   • per-regime breakdown (trend/chop, high/low volatility, gap, expiry, side)
 *   • year-by-year and quarter-by-quarter stability
 *
 * Read the caveats in src/strategies/orb_breakout.js before acting on the output.
 */

process.env.TZ = "Asia/Calcutta";
require("dotenv").config();

const path = require("path");
const { ATR } = require("technicalindicators");
const orb = require(path.join(__dirname, "../src/strategies/orb_breakout"));
const orbExits = require(path.join(__dirname, "../src/strategies/orbExits"));
const orbStopRisk = require(path.join(__dirname, "../src/utils/orbStopRisk"));
const { fetchCandlesCachedBT } = require(path.join(__dirname, "../src/services/backtestEngine"));

const SYMBOL = "NSE:NIFTY50-INDEX";
const r2 = x => Math.round(x * 100) / 100;
const DAY = t => Math.floor((t + 19800) / 86400);
const MIN = t => Math.floor((t + 19800) / 60) % 1440;
const DATE = t => new Date((t + 19800) * 1000).toISOString().slice(0, 10);

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

// ── Cost model: keep it pessimistic. Spot points flatter a strategy whose exits
//    cluster at breakeven, because a 0-point scratch is still a real rupee loss.
const QTY    = parseInt(process.env.NIFTY_LOT_SIZE || "65", 10) * parseInt(process.env.LOT_MULTIPLIER || "1", 10);
const DELTA  = parseFloat(process.env.BACKTEST_DELTA || "0.6");
const SLIP   = parseFloat(process.env.ORB_BT_SLIPPAGE_PTS || "1.5");   // premium pts EACH way
const THETA  = 2.5;                                                     // premium pts, typical intraday hold
const CHARGE = 60;                                                      // INR round trip
const toINR = spotPts => r2((DELTA * spotPts - 2 * SLIP - THETA) * QTY - CHARGE);

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
function line(label, s) {
  if (!s) return `  ${label.padEnd(26)} (no trades)`;
  return `  ${label.padEnd(26)} n=${String(s.n).padStart(4)}  net=${String(s.net).padStart(10)}  exp=${String(s.exp).padStart(8)}  WR=${String(s.wr).padStart(5)}%  PF=${String(s.pf === Infinity ? "inf" : s.pf).padStart(6)}  avgW=${String(s.avgWin).padStart(8)}  avgL=${String(s.avgLoss).padStart(9)}  worst=${String(s.worst).padStart(9)}`;
}

(async () => {
  const from = arg("from", "2024-01-01"), to = arg("to", new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }));
  console.log(`\nORB long-sample validation  ${from} → ${to}`);
  console.log(`cost model: qty ${QTY}, delta ${DELTA}, slippage ${SLIP}pt/side, theta ${THETA}pt, charges ₹${CHARGE}`);
  console.log(`a 0-spot-point scratch costs ${toINR(0)} INR\n`);

  let candles;
  try {
    candles = await fetchCandlesCachedBT(SYMBOL, "5", from, to, false, m => process.stdout.write(`\r${m}   `));
    process.stdout.write("\r");
  } catch (e) {
    console.error(`\nFetch failed: ${e.message}`);
    console.error(`This usually means the Fyers token is missing or expired — log in at /auth/login, then re-run.`);
    process.exit(1);
  }
  if (!candles || candles.length < 500) {
    console.error(`Only ${candles ? candles.length : 0} candles returned. An expired Fyers token returns no_data (0 candles) rather than an auth error — re-login and retry.`);
    process.exit(1);
  }
  candles.sort((a, b) => a.time - b.time);
  const IDX = new Map(candles.map((c, i) => [c.time, i]));
  const DAYS = [...new Set(candles.map(c => DAY(c.time)))].sort((a, b) => a - b);
  console.log(`${candles.length} candles over ${DAYS.length} sessions\n`);

  // (the EMA trend-trail now comes from orbExits.evaluateCloseExits — no local copy)

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
        side, entrySpot: entry, strategyStop: sig.slSpot, qty: QTY,
        fallbackStop: side === "CE" ? sig.orl : sig.orh,
      });
      // ── Exit model. Driven by the SHARED exit engine (src/strategies/orbExits.js)
      //    — the same functions paper, live and the backtest route run, so the
      //    statistics this script publishes describe the shipped strategy rather
      //    than a fourth hand-written copy of it.
      //
      //    ORDER MIRRORS PAPER'S REAL TIMELINE:
      //      per TICK   (_checkExits)            → rupee cap / premium stop / hard SL
      //      per CLOSE  (_managePositionOnClose) → opposite candle → breakeven → EMA
      //    so intrabar exits get first refusal inside a candle and a close-based rule
      //    can only fire on a bar that never touched the stop. The rupee cap is
      //    already folded into the stop by orbStopRisk above (it clamps to the level
      //    ORB_MAX_TRADE_LOSS allows), so the spot SL here IS the cap.
      //
      //    `pos` is the minimal shape orbExits needs; it is mutated in place for
      //    breakeven / EMA arming exactly as a live position would be.
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
        const d = orbExits.evaluateCloseExits(pos, c, candles.slice(Math.max(0, ci - 199), ci + 1));
        if (d.exit) {
          exit = c.close;
          why = /EMA/.test(d.reason) ? "trail" : "opp";
          break;
        }
      }
      if (exit == null) { const rest = dayC.slice(j + 1); exit = (rest[rest.length - 1] || bar).close; why = "EOD"; }

      const pts = r2(side === "CE" ? exit - entry : entry - exit);
      const a = ATR.calculate({ period: 14, high: win.map(c => c.high), low: win.map(c => c.low), close: win.map(c => c.close) });
      trades.push({
        date: DATE(bar.time), side, pts, inr: toINR(pts), why, mae: r2(mae), mfe: r2(mfe),
        orPts: sig.rangePts, gap: sig.gapPts, atr5: a.length ? r2(a[a.length - 1]) : null,
        orAtr: sig.atr15 ? r2(sig.rangePts / sig.atr15) : null,
        clamped: st.clamped,
      });
      break;
    }
  }

  if (!trades.length) { console.log("No trades generated — check ORB_* config."); return; }

  console.log(`${"═".repeat(120)}\nOVERALL\n${"═".repeat(120)}`);
  console.log(line("all trades", stats(trades)));
  console.log(`  trades per session: ${r2(trades.length / DAYS.length)}   stop clamped by the rupee budget on ${trades.filter(t => t.clamped).length}/${trades.length}`);

  // ── Statistical honesty: bootstrap + concentration ──
  const inrs = trades.map(t => t.inr);
  let seed = 987654321; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const B = 20000, means = [];
  for (let b = 0; b < B; b++) { let s = 0; for (let i = 0; i < inrs.length; i++) s += inrs[Math.floor(rnd() * inrs.length)]; means.push(s / inrs.length); }
  means.sort((a, b) => a - b);
  const net = inrs.reduce((a, b) => a + b, 0);
  const top = [...trades].sort((a, b) => b.inr - a.inr);
  console.log(`\n${"═".repeat(120)}\nIS IT REAL?\n${"═".repeat(120)}`);
  console.log(`  bootstrap 95% CI on mean/trade : [${r2(means[Math.floor(B * 0.025)])}, ${r2(means[Math.floor(B * 0.975)])}] INR`);
  console.log(`  P(true edge <= 0)              : ${r2(means.filter(m => m <= 0).length / B * 100)}%`);
  console.log(`  best trade share of net        : ${r2(top[0].inr / net * 100)}%   (top 5: ${r2(top.slice(0, 5).reduce((a, t) => a + t.inr, 0) / net * 100)}%)`);
  console.log(`  net without the best trade     : ${r2(net - top[0].inr)} INR`);
  console.log(`  -> treat as a real edge only if the CI excludes 0 AND no single trade dominates.`);

  // ── Regime breakdown ──
  const med = a => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  const medAtr = med(trades.map(t => t.atr5).filter(Boolean));
  const medOr  = med(trades.map(t => t.orPts).filter(Boolean));
  console.log(`\n${"═".repeat(120)}\nBY REGIME  (medians: ATR5 ${medAtr}pt, OR ${medOr}pt)\n${"═".repeat(120)}`);
  const groups = {
    "CE (long)":            t => t.side === "CE",
    "PE (short)":           t => t.side === "PE",
    "high volatility":      t => t.atr5 != null && t.atr5 >= medAtr,
    "low volatility":       t => t.atr5 != null && t.atr5 < medAtr,
    "wide opening range":   t => t.orPts >= medOr,
    "narrow opening range": t => t.orPts < medOr,
    "OR < 1.5x ATR15":      t => t.orAtr != null && t.orAtr < 1.5,
    "OR >= 1.5x ATR15":     t => t.orAtr != null && t.orAtr >= 1.5,
    "gap up > 0.3% ":       t => t.gap != null && t.gap > 0,
    "gap down":             t => t.gap != null && t.gap < 0,
    "exit: trail":          t => t.why === "trail",
    "exit: breakeven":      t => t.why === "BE",
    "exit: stop":           t => t.why === "SL",
    "exit: opposite candle":t => t.why === "opp",
    "exit: EOD":            t => t.why === "EOD",
  };
  for (const [k, f] of Object.entries(groups)) console.log(line(k, stats(trades.filter(f))));

  // ── Stability over time ──
  console.log(`\n${"═".repeat(120)}\nSTABILITY OVER TIME (an edge that only exists in one year is not an edge)\n${"═".repeat(120)}`);
  const years = [...new Set(trades.map(t => t.date.slice(0, 4)))].sort();
  for (const y of years) console.log(line(y, stats(trades.filter(t => t.date.startsWith(y)))));
  const quarters = [...new Set(trades.map(t => `${t.date.slice(0, 4)}-Q${Math.floor((+t.date.slice(5, 7) - 1) / 3) + 1}`))].sort();
  console.log();
  for (const q of quarters) {
    const f = trades.filter(t => `${t.date.slice(0, 4)}-Q${Math.floor((+t.date.slice(5, 7) - 1) / 3) + 1}` === q);
    console.log(line(q, stats(f)));
  }

  console.log(`\n${"═".repeat(120)}`);
  console.log(`Sample size check: ${trades.length} trades. ~147 are needed for 95% confidence / 80% power at the`);
  console.log(`effect size seen on the original 39-session study. ${trades.length >= 147 ? "SUFFICIENT — read the CI above." : "STILL INSUFFICIENT — widen the date range."}`);
  console.log(`${"═".repeat(120)}\n`);
})();

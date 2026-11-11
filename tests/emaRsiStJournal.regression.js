#!/usr/bin/env node
/**
 * emaRsiStJournal.regression.js — every EMA_RSI_ST paper trade carries its
 * trade journal (utils/tradeJournal): entry, peak, stop history and exit.
 *
 *   node tests/emaRsiStJournal.regression.js
 *
 * Replays ONE synthetic session (the golden harness's own inputs and sandbox —
 * scripts/strategyBaseline.js + scripts/lib/baselineWorker.js) through the real
 * route on three pair instances: NIFTY (home, option bought at the first LTP),
 * SENSEX (option bought at the ask) and NIFTY_FUT (futures, index stop). The
 * full trade objects are read from the replay's trade log, i.e. exactly what
 * simulateSell() built and appendTradeLog() received.
 *
 * Observer-only is proven elsewhere: `npm run test:baseline` must stay
 * byte-identical for emaRsiStPaper and its three pair goldens.
 */

"use strict";

const assert = require("assert");
const fs     = require("fs");
const os     = require("os");
const path   = require("path");

const REPO     = path.resolve(__dirname, "..");
const baseline = require(path.join(REPO, "scripts", "strategyBaseline.js"));
const { SETTINGS, RECORDING_SPEC, PAIRS, runWorker } = baseline.harness;

const DATE = "2026-10-14";   // or_retest_whipsaw: 3+ trades on all three markets, incl. profit-lock and stop exits
const RUNS = [
  { market: "NIFTY",     mode: "ema_rsi_st-paper",        logKey: "ema_rsi_st",        isFutures: false },
  { market: "SENSEX",    mode: "sensex_ema_rsi_st-paper", logKey: "sensex_ema_rsi_st", isFutures: false },
  { market: "NIFTY_FUT", mode: "fut_ema_rsi_st-paper",    logKey: "fut_ema_rsi_st",    isFutures: true },
];

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); pass++; }
  catch (e) { console.log(`  ❌ ${name}\n       ${e.message}`); fail++; }
}
const num = (v) => typeof v === "number" && Number.isFinite(v);

async function replay(tmpRoot, run) {
  const ticks = path.join(tmpRoot, `ticks-${run.market}`);
  fs.mkdirSync(ticks, { recursive: true });
  const pair = PAIRS.find(p => p.mode === run.mode);
  const settings = pair ? { ...SETTINGS, [pair.enabledKey]: "true" } : SETTINGS;
  const spec = path.join(tmpRoot, `spec-${run.market}.json`);
  fs.writeFileSync(spec, JSON.stringify({ ...RECORDING_SPEC, settings, modes: [run.mode] }));
  const gArgs = ["--generate", "--ticks", ticks, "--settings", spec, "--out", path.join(tmpRoot, `gen-${run.market}.json`)];
  if (pair) gArgs.splice(1, 0, "--market", run.market);
  const g = await runWorker(gArgs, tmpRoot, `gen-${run.market}`);
  if (g.code !== 0) throw new Error(`${run.market}: recording failed (exit ${g.code}) — ${g.log}\n${g.stderr}`);
  const out = path.join(tmpRoot, `run-${run.market}.json`);
  const rArgs = ["--mode", run.mode, "--date", DATE, "--ticks", ticks, "--out", out];
  if (pair) rArgs.push("--market", run.market);
  const r = await runWorker(rArgs, tmpRoot, `run-${run.market}`);
  const res = JSON.parse(fs.readFileSync(out, "utf8"));
  if (r.code !== 0 || !res.ok) throw new Error(`${run.market}: replay failed (exit ${r.code}) ${res.error || ""} — ${r.log}`);
  const log = path.join(ticks, "_replay_trades", `${run.logKey}_replay.jsonl`);
  const trades = fs.existsSync(log)
    ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l))
    : [];
  return { res, trades };
}

function checkMarket(run, { res, trades }) {
  console.log(`\n${run.market} (${run.mode}, ${DATE})`);
  check("the session booked trades, and the trade log has every one of them", () => {
    assert.ok(trades.length > 0, "no trades — the session should trade");
    assert.strictEqual(trades.length, res.trades.length, "trade log vs session book");
  });
  check("every trade carries a journal with entry / peak / stops / exit", () => {
    for (const t of trades) {
      const j = t.journal;
      assert.ok(j && typeof j === "object", `no journal on ${t.entryTime}`);
      assert.strictEqual(j.market, run.market);
      assert.strictEqual(j.strategy, "EMA_RSI_ST");
      assert.strictEqual(j.side, t.side);
      assert.strictEqual(j.isFutures, run.isFutures);
      // entry
      assert.ok(num(j.entry.ms) && j.entry.date === DATE, "entry time");
      assert.strictEqual(j.entry.reason, t.entryReason);
      assert.strictEqual(j.entry.signal, t.side === "CE" ? "BUY_CE" : "BUY_PE");
      assert.strictEqual(j.entry.spot, t.spotAtEntry);
      assert.ok(num(j.entry.indicators.rsi) && num(j.entry.indicators.ema20), "entry indicators");
      assert.ok(Array.isArray(j.entry.candles) && j.entry.candles.length, "entry candles");
      // peak / drawdown
      assert.ok(j.peak && num(j.peak.pts) && num(j.peak.ms), "peak");
      assert.ok(j.worst && num(j.worst.pts), "worst");
      assert.ok(j.ticks > 0, "ticks");
      // The route's MFE starts at 0; the journal's peak is the best tick, even when negative.
      if (t.mfeSpotPts > 0) assert.ok(Math.abs(j.peak.pts - t.mfeSpotPts) < 0.011, `peak ${j.peak.pts} vs route MFE ${t.mfeSpotPts}`);
      else assert.ok(j.peak.pts <= 0, "no favourable tick → peak ≤ 0");
      assert.ok(j.worst.pts <= j.peak.pts, "worst ≤ peak");
      // stops: the level the profit lock / premium stop / futures stop fills at
      assert.ok(j.stops.length > 0, "stop history");
      assert.strictEqual(j.stops[0].kind, "initial");
      for (const s of j.stops) assert.ok(num(s.to) && num(s.ms), `stop #${s.n}`);
      // exit
      assert.ok(j.exit && num(j.exit.ms), "exit");
      assert.strictEqual(j.exit.reason, t.exitReason);
      assert.ok(["sl", "trail", "manual", "eod"].includes(j.exit.kind), `exit kind ${j.exit.kind}`);
      assert.ok(num(j.exit.fill) && num(j.exit.holdMin), "exit fill / hold");
      assert.ok(num(j.exit.finalStop), "final stop");
      if (j.exit.kind === "sl" || j.exit.kind === "trail") {
        assert.strictEqual(j.exit.expectedPrice, j.exit.finalStop, "a stop exit aims at the recorded level");
      }
      if (run.isFutures) {
        assert.strictEqual(j.entry.optionLtp, null);
        assert.strictEqual(j.entry.fill, t.entryPrice);
        assert.strictEqual(j.exit.fill, t.exitPrice);
      } else {
        assert.strictEqual(j.entry.optionLtp, t.optionEntryLtp, "entry premium = the trade's");
        assert.strictEqual(j.entry.fill, t.optionEntryLtp);
        assert.strictEqual(j.exit.optionLtp, t.optionExitLtp, "exit premium = the trade's");
      }
    }
  });
  check("the golden harness drops the journal and nothing else", () => {
    const t = trades[0];
    const s = baseline.stripObserverKeys(t);
    assert.ok(!("journal" in s));
    assert.deepStrictEqual(Object.keys(s), Object.keys(t).filter(k => k !== "journal"));
  });
}

(async () => {
  const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ema-rsi-st-journal-")));
  let ok = false;
  try {
    const results = await Promise.all(RUNS.map(r => replay(tmpRoot, r)));
    RUNS.forEach((r, i) => checkMarket(r, results[i]));

    console.log("\nAcross markets");
    check("a profit-lock / stop exit and an option entry at the ask are both exercised", () => {
      const all = results.flatMap(x => x.trades);
      assert.ok(all.some(t => t.journal.exit.kind === "trail"), "no trailing exit in the sample");
      const sx = results[1].trades;
      assert.ok(sx.some(t => t.optionEntryFill === "ask" && num(t.journal.entry.slippagePts)), "SENSEX ask fill → entry slippage");
    });
    ok = fail === 0;
  } catch (e) {
    console.log(`  ❌ ${e.stack || e}`);
    fail++;
  } finally {
    if (ok) fs.rmSync(tmpRoot, { recursive: true, force: true });
    else console.log(`(temp dir kept: ${tmpRoot})`);
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();

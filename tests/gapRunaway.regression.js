/**
 * GAP_RUNAWAY (GAP_runAway__Kirubakaran) — engine rules + wiring invariants.
 * Zero-dependency; run with `node tests/gapRunaway.regression.js` (part of npm test).
 *
 * Engine: yesterday's daily RSI(10) on EMA21 < 10 + gap UP → CE, > 90 + gap DOWN
 * → PE; stop = yesterday's close (a LEVEL, per tick); trail = exit-TF close
 * through EMA21; square-off 15:15; entry window 09:15–09:30. No common rules.
 */
const assert = require("assert");
const fs     = require("fs");
const path   = require("path");
const { EMA, RSI } = require("technicalindicators");

const SRC = path.join(__dirname, "../src");
const read = (rel) => fs.readFileSync(path.join(SRC, rel), "utf-8");
const decomment = (s) => s.split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

let pass = 0, fail = 0;
function section(t) { console.log(`\n${t}`); }
function check(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); pass++; }
  catch (e) { console.log(`  ❌ ${name}\n       ${e.message}`); fail++; }
}

// Isolate from the operator's .env — the engine reads process.env live.
for (const k of Object.keys(process.env)) if (/^GAP_RUNAWAY/.test(k)) delete process.env[k];
const eng = require("../src/strategies/gap_runaway");
const cfg = () => eng.getConfig("GAP_RUNAWAY");

const DAY = 86400;
const IST = 19800;
/** A daily bar stamped 00:00 IST of IST day `k` (Fyers' daily convention). */
const dayBar = (k, close, open) => ({ time: k * DAY - IST, open: open != null ? open : close, high: Math.max(close, open || close) + 5, low: Math.min(close, open || close) - 5, close });
const TODAY = 20400;   // an arbitrary IST day index
/** n daily bars ending the day before TODAY, closes from fn(i). */
function series(n, fn) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(dayBar(TODAY - n + i, fn(i)));
  return out;
}
const falling = series(160, (i) => 20000 + (i < 120 ? 0 : -(i - 120) * 60));     // steady then a hard slide → oversold
const rising  = series(160, (i) => 20000 + (i < 120 ? 0 : (i - 120) * 60));      // steady then a hard rally → overbought
const choppy  = series(160, (i) => 20000 + 60 * Math.sin(i * 0.7) + 25 * Math.cos(i * 1.9)); // sideways → neutral

// ─────────────────────────────────────────────────────────────────────────────
section("Config — defaults and live reads");

check("defaults are the user's rules (RSI 10 on EMA21, 90/10, 5-min EMA21 trail, 09:15–09:30, 15:15)", () => {
  const c = cfg();
  assert.strictEqual(c.EMA_LENGTH, 21); assert.strictEqual(c.RSI_LENGTH, 10);
  assert.strictEqual(c.RSI_UPPER, 90); assert.strictEqual(c.RSI_LOWER, 10);
  assert.strictEqual(c.MIN_GAP_PTS, 0); assert.strictEqual(c.TRAIL_EMA_LENGTH, 21); assert.strictEqual(c.EXIT_TF, 5);
  assert.strictEqual(c.ENTRY_START, 555); assert.strictEqual(c.ENTRY_END, 570); assert.strictEqual(c.EOD_EXIT, 915);
});
check("settings are read live (never cached)", () => {
  process.env.GAP_RUNAWAY_RSI_UPPER = "85";
  try { assert.strictEqual(cfg().RSI_UPPER, 85); } finally { delete process.env.GAP_RUNAWAY_RSI_UPPER; }
  assert.strictEqual(cfg().RSI_UPPER, 90);
});
check("each prefix reads its own keys (the stock scanner does not inherit NIFTY's)", () => {
  process.env.GAP_RUNAWAY_STK_MIN_GAP_PTS = "7";
  try {
    assert.strictEqual(eng.getConfig("GAP_RUNAWAY_STK").MIN_GAP_PTS, 7);
    assert.strictEqual(cfg().MIN_GAP_PTS, 0);
  } finally { delete process.env.GAP_RUNAWAY_STK_MIN_GAP_PTS; }
});
check("an unknown prefix falls back to GAP_RUNAWAY, never another strategy's keys", () => {
  assert.strictEqual(eng.getConfig("PIVOT_EMA_ST").PREFIX, "GAP_RUNAWAY");
});
check("garbage values fall back to the defaults", () => {
  process.env.GAP_RUNAWAY_EXIT_TF = "7"; process.env.GAP_RUNAWAY_RSI_LENGTH = "abc"; process.env.GAP_RUNAWAY_ENTRY_END = "25:99";
  try { const c = cfg(); assert.strictEqual(c.EXIT_TF, 5); assert.strictEqual(c.RSI_LENGTH, 10); assert.strictEqual(c.ENTRY_END, 570); }
  finally { delete process.env.GAP_RUNAWAY_EXIT_TF; delete process.env.GAP_RUNAWAY_RSI_LENGTH; delete process.env.GAP_RUNAWAY_ENTRY_END; }
});
check("an inverted band (upper ≤ lower) falls back to 90 / 10", () => {
  process.env.GAP_RUNAWAY_RSI_UPPER = "20"; process.env.GAP_RUNAWAY_RSI_LOWER = "30";
  try { const c = cfg(); assert.strictEqual(c.RSI_UPPER, 90); assert.strictEqual(c.RSI_LOWER, 10); }
  finally { delete process.env.GAP_RUNAWAY_RSI_UPPER; delete process.env.GAP_RUNAWAY_RSI_LOWER; }
});
check("the reference video is stored and exposed", () => {
  assert.strictEqual(eng.referenceUrl("GAP_RUNAWAY"), "https://www.youtube.com/watch?v=uLTaXTyDxiI");
  process.env.GAP_RUNAWAY_REFERENCE_URL = "not a url";
  try { assert.strictEqual(eng.referenceUrl("GAP_RUNAWAY"), eng.REFERENCE_URL); } finally { delete process.env.GAP_RUNAWAY_REFERENCE_URL; }
});

// ─────────────────────────────────────────────────────────────────────────────
section("Indicators — RSI on the EMA21 line, alignment asserted");

check("EMA(21) aligns out[i] ↔ daily[i+20]", () => {
  const s = eng.computeDaily(falling, cfg());
  const e = EMA.calculate({ period: 21, values: falling.map(c => c.close) });
  assert.strictEqual(s.ema[19], null);
  assert.strictEqual(s.ema[20], e[0]);
  assert.strictEqual(s.ema[falling.length - 1], e[e.length - 1]);
});
check("RSI(10) is computed over the EMA values and aligns rsi[j+10+20] ↔ out[j]", () => {
  const s = eng.computeDaily(falling, cfg());
  const e = EMA.calculate({ period: 21, values: falling.map(c => c.close) });
  const r = RSI.calculate({ period: 10, values: e });
  assert.strictEqual(s.rsi[29], null);
  assert.strictEqual(s.rsi[30], r[0]);
  assert.strictEqual(s.rsi[falling.length - 1], r[r.length - 1]);
});
check("RSI on the EMA line is NOT RSI on the close (the source really is the EMA)", () => {
  const s = eng.computeDaily(choppy, cfg());
  const onClose = RSI.calculate({ period: 10, values: choppy.map(c => c.close) });
  assert.notStrictEqual(s.rsi[choppy.length - 1], onClose[onClose.length - 1]);
});
check("trail EMA aligns out[i] ↔ candles[i+20]", () => {
  const bars = Array.from({ length: 30 }, (_, i) => ({ time: i * 300, open: 100 + i, high: 101 + i, low: 99 + i, close: 100 + i }));
  const t = eng.computeTrailEma(bars, cfg());
  const e = EMA.calculate({ period: 21, values: bars.map(b => b.close) });
  assert.strictEqual(t[19], null); assert.strictEqual(t[20], e[0]); assert.strictEqual(t[29], e[e.length - 1]);
});

// ─────────────────────────────────────────────────────────────────────────────
section("Daily setup — yesterday's closed bar, refusals");

const osSetup = eng.dailySetup(falling, TODAY, cfg());
const obSetup = eng.dailySetup(rising, TODAY, cfg());
const nSetup  = eng.dailySetup(choppy, TODAY, cfg());
check("a hard slide reads OVERSOLD (RSI < 10)", () => { assert.ok(osSetup.ready); assert.strictEqual(osSetup.zone, "OVERSOLD"); assert.ok(osSetup.prevRsi < 10, `rsi ${osSetup.prevRsi}`); });
check("a hard rally reads OVERBOUGHT (RSI > 90)", () => { assert.ok(obSetup.ready); assert.strictEqual(obSetup.zone, "OVERBOUGHT"); assert.ok(obSetup.prevRsi > 90, `rsi ${obSetup.prevRsi}`); });
check("a flat market reads NEUTRAL", () => { assert.ok(nSetup.ready); assert.strictEqual(nSetup.zone, "NEUTRAL"); });
check("prevClose is yesterday's close, prevDate its IST date", () => {
  assert.strictEqual(osSetup.prevClose, falling[falling.length - 1].close);
  assert.strictEqual(osSetup.prevDayKey, TODAY - 1);
});
check("today's forming daily bar is IGNORED (it cannot move the decision)", () => {
  const withToday = falling.concat([dayBar(TODAY, 99999)]);
  const s = eng.dailySetup(withToday, TODAY, cfg());
  assert.strictEqual(s.prevClose, osSetup.prevClose); assert.strictEqual(s.prevRsi, osSetup.prevRsi);
});
check("unsorted input gives the same answer", () => {
  const s = eng.dailySetup(falling.slice().reverse(), TODAY, cfg());
  assert.strictEqual(s.prevRsi, osSetup.prevRsi);
});
check("warm-up: fewer than minDailyBars() is refused", () => {
  const s = eng.dailySetup(falling.slice(-50), TODAY, cfg());
  assert.strictEqual(s.ready, false); assert.ok(s.warmup); assert.ok(/Warming up/.test(s.reason));
  assert.strictEqual(eng.minDailyBars(cfg()), 100);
});
check("two daily bars on one IST day (intraday candles) are refused", () => {
  const bad = falling.slice(); bad.push({ ...bad[bad.length - 1], time: bad[bad.length - 1].time + 300 });
  const s = eng.dailySetup(bad, TODAY, cfg());
  assert.strictEqual(s.ready, false); assert.ok(/intraday/.test(s.reason));
});
check("a stale feed (newest bar > 7 days old) is refused", () => {
  const s = eng.dailySetup(falling, TODAY + 10, cfg());
  assert.strictEqual(s.ready, false); assert.ok(/Stale/.test(s.reason));
});
check("non-finite bars are skipped, never read as 0", () => {
  const bad = falling.slice(); bad.splice(80, 0, { time: (TODAY - 500) * DAY, open: null, high: "", low: NaN, close: null });
  const s = eng.dailySetup(bad, TODAY, cfg());
  assert.ok(s.ready); assert.strictEqual(s.prevRsi, osSetup.prevRsi);
});
check("no session day / no candles → refused", () => {
  assert.strictEqual(eng.dailySetup(falling, null, cfg()).ready, false);
  assert.strictEqual(eng.dailySetup([], TODAY, cfg()).ready, false);
  assert.strictEqual(eng.dailySetup(null, TODAY, cfg()).ready, false);
});

// ─────────────────────────────────────────────────────────────────────────────
section("Entry — the four combinations, gap size, open price");

const pc = osSetup.prevClose;
check("OVERSOLD + gap UP → BUY_CE, SL = prev close, slPts = gap", () => {
  const s = eng.getSignal({ setup: osSetup, todayOpen: pc + 80, cfg: cfg() });
  assert.strictEqual(s.signal, "BUY_CE"); assert.strictEqual(s.side, "CE");
  assert.strictEqual(s.slSpot, pc); assert.strictEqual(s.slPts, 80); assert.strictEqual(s.gapDir, "UP"); assert.strictEqual(s.entrySpot, pc + 80);
});
check("OVERSOLD + gap DOWN → NONE (needs a gap UP)", () => {
  const s = eng.getSignal({ setup: osSetup, todayOpen: pc - 30, cfg: cfg() });
  assert.strictEqual(s.signal, "NONE"); assert.strictEqual(s.skipReason, "gap_wrong_way");
});
const pcB = obSetup.prevClose;
check("OVERBOUGHT + gap DOWN → BUY_PE, SL = prev close", () => {
  const s = eng.getSignal({ setup: obSetup, todayOpen: pcB - 50, cfg: cfg() });
  assert.strictEqual(s.signal, "BUY_PE"); assert.strictEqual(s.side, "PE"); assert.strictEqual(s.slSpot, pcB); assert.strictEqual(s.slPts, 50);
});
check("OVERBOUGHT + gap UP → NONE", () => {
  const s = eng.getSignal({ setup: obSetup, todayOpen: pcB + 50, cfg: cfg() });
  assert.strictEqual(s.signal, "NONE"); assert.strictEqual(s.skipReason, "gap_wrong_way");
});
check("NEUTRAL never trades, whatever the gap", () => {
  for (const g of [-200, -1, 1, 200]) assert.strictEqual(eng.getSignal({ setup: nSetup, todayOpen: nSetup.prevClose + g, cfg: cfg() }).signal, "NONE");
});
check("open exactly at prev close is no gap", () => {
  const s = eng.getSignal({ setup: osSetup, todayOpen: pc, cfg: cfg() });
  assert.strictEqual(s.signal, "NONE"); assert.strictEqual(s.skipReason, "no_gap");
});
check("any gap counts at the default (a 1-pt gap up trades)", () => {
  assert.strictEqual(eng.getSignal({ setup: osSetup, todayOpen: pc + 1, cfg: cfg() }).signal, "BUY_CE");
});
check("MIN_GAP_PTS is honoured (20 pts refuses a 10-pt gap, takes a 20-pt one)", () => {
  process.env.GAP_RUNAWAY_MIN_GAP_PTS = "20";
  try {
    assert.strictEqual(eng.getSignal({ setup: osSetup, todayOpen: pc + 10, cfg: cfg() }).skipReason, "gap_too_small");
    assert.strictEqual(eng.getSignal({ setup: osSetup, todayOpen: pc + 20, cfg: cfg() }).signal, "BUY_CE");
  } finally { delete process.env.GAP_RUNAWAY_MIN_GAP_PTS; }
});
check("the RSI thresholds are configurable (lower band 0 → nothing is oversold)", () => {
  process.env.GAP_RUNAWAY_RSI_LOWER = "0";
  try { assert.notStrictEqual(eng.dailySetup(falling, TODAY, cfg()).zone, "OVERSOLD"); }
  finally { delete process.env.GAP_RUNAWAY_RSI_LOWER; }
});
check("no / bad open → NONE no_open (never a 0 price)", () => {
  for (const o of [null, undefined, 0, -5, NaN, "24000", ""]) {
    const s = eng.getSignal({ setup: osSetup, todayOpen: o, cfg: cfg() });
    assert.strictEqual(s.signal, "NONE"); assert.strictEqual(s.skipReason, "no_open");
  }
});
check("a setup that is not ready → NONE warmup", () => {
  assert.strictEqual(eng.getSignal({ setup: null, todayOpen: 100, cfg: cfg() }).skipReason, "warmup");
  assert.strictEqual(eng.getSignal({ setup: { ready: false, reason: "x" }, todayOpen: 100, cfg: cfg() }).skipReason, "warmup");
});
check("gapPct is signed and relative to prev close", () => {
  const s = eng.getSignal({ setup: obSetup, todayOpen: pcB * 0.99, cfg: cfg() });
  assert.ok(Math.abs(s.gapPct + 1) < 0.01, `gapPct ${s.gapPct}`);
});

// ─────────────────────────────────────────────────────────────────────────────
section("Stop — a LEVEL at yesterday's close, per tick");

check("CE stops when price ≤ prev close, not above", () => {
  assert.ok(eng.stopHit("CE", 24000, 24000)); assert.ok(eng.stopHit("CE", 23990, 24000)); assert.ok(!eng.stopHit("CE", 24000.05, 24000));
});
check("PE stops when price ≥ prev close, not below", () => {
  assert.ok(eng.stopHit("PE", 24000, 24000)); assert.ok(eng.stopHit("PE", 24010, 24000)); assert.ok(!eng.stopHit("PE", 23999.95, 24000));
});
check("a null / NaN stop never fires (spot >= null would be spot >= 0)", () => {
  for (const sl of [null, undefined, NaN, ""]) { assert.ok(!eng.stopHit("CE", 24000, sl)); assert.ok(!eng.stopHit("PE", 24000, sl)); }
  assert.ok(!eng.stopHit("CE", null, 24000)); assert.ok(!eng.stopHit("PE", 0, 24000)); assert.ok(!eng.stopHit("XX", 1, 2));
});
check("entry is refused once the gap has filled", () => {
  assert.ok(eng.entryStillValid("CE", 24050, 24000)); assert.ok(!eng.entryStillValid("CE", 24000, 24000)); assert.ok(!eng.entryStillValid("CE", 23900, 24000));
  assert.ok(eng.entryStillValid("PE", 23950, 24000)); assert.ok(!eng.entryStillValid("PE", 24001, 24000));
  assert.ok(!eng.entryStillValid("CE", null, 24000)); assert.ok(!eng.entryStillValid("CE", 24050, null));
});

// ─────────────────────────────────────────────────────────────────────────────
section("Trail — a candle CLOSE back through EMA21 (not a target, not a wick)");

const bar = (o, h, l, c) => ({ time: 1, open: o, high: h, low: l, close: c });
check("CE exits on a close below the EMA", () => { assert.ok(eng.trailExit("CE", bar(105, 106, 98, 99), 100, cfg()).exit); });
check("CE holds on a close above the EMA even if the wick pierced it", () => { assert.ok(!eng.trailExit("CE", bar(105, 106, 95, 101), 100, cfg()).exit); });
check("PE exits on a close above the EMA", () => { assert.ok(eng.trailExit("PE", bar(95, 102, 94, 101), 100, cfg()).exit); });
check("PE holds on a close below the EMA even if the wick pierced it", () => { assert.ok(!eng.trailExit("PE", bar(95, 105, 94, 99), 100, cfg()).exit); });
check("a close exactly on the EMA does not exit", () => { assert.ok(!eng.trailExit("CE", bar(1, 2, 0, 100), 100, cfg()).exit); assert.ok(!eng.trailExit("PE", bar(1, 2, 0, 100), 100, cfg()).exit); });
check("no EMA yet (warm-up) never exits", () => { assert.ok(!eng.trailExit("CE", bar(1, 2, 0, 1), null, cfg()).exit); assert.ok(!eng.trailExit("CE", bar(1, 2, 0, 1), NaN, cfg()).exit); });
check("a bad bar never exits", () => { assert.ok(!eng.trailExit("CE", { time: 1, open: 1, high: 1, low: 1, close: null }, 100, cfg()).exit); });
check("the reason names the timeframe and the EMA", () => { assert.ok(/5-min close .* below EMA21/.test(eng.trailExit("CE", bar(105, 106, 98, 99), 100, cfg()).reason)); });

// ─────────────────────────────────────────────────────────────────────────────
section("Windows — entry 09:15–09:30, square-off 15:15");

const at = (h, m) => (TODAY * DAY - IST) + (h * 60 + m) * 60;
check("09:15 and 09:30 are inside the entry window; 09:14 and 09:31 are not", () => {
  assert.ok(eng.isInEntryWindow(at(9, 15), cfg())); assert.ok(eng.isInEntryWindow(at(9, 30), cfg()));
  assert.ok(!eng.isInEntryWindow(at(9, 14), cfg())); assert.ok(!eng.isInEntryWindow(at(9, 31), cfg()));
});
check("square-off fires at 15:15, not 15:14", () => { assert.ok(eng.isEodExit(at(15, 15), cfg())); assert.ok(!eng.isEodExit(at(15, 14), cfg())); });

// ─────────────────────────────────────────────────────────────────────────────
section("Routes — rules live only in the engine; no common rules");

const paper = decomment(read("routes/gapRunawayPaper.js"));
const stk   = decomment(read("routes/gapRunawayStkPaper.js"));
const harn  = decomment(read("routes/gapRunawayLiveHarness.js"));
check("no route does indicator maths of its own", () => {
  for (const [n, s] of [["paper", paper], ["stk", stk], ["harness", harn]]) {
    assert.ok(!/technicalindicators|EMA\.calculate|RSI\.calculate/.test(s), `${n} computes an indicator`);
  }
});
check("no route compares RSI to a band itself", () => {
  for (const s of [paper, stk]) assert.ok(!/prevRsi\s*[<>]=?\s*\d|RSI_UPPER\s*[<>]|RSI_LOWER\s*[<>]/.test(s));
});
check("both routes decide through engine.getSignal / stopHit / trailExit", () => {
  for (const s of [paper, stk]) {
    assert.ok(/engine\.getSignal\(/.test(s)); assert.ok(/engine\.stopHit\(/.test(s));
    assert.ok(/engine\.trailExit\(/.test(s)); assert.ok(/engine\.entryStillValid\(/.test(s));
  }
});
check("no common rule: no profit lock, breakeven, cooldown, spread check, capital pool, portfolio cap, LOT_MULTIPLIER", () => {
  for (const s of [paper, stk]) {
    assert.ok(!/tradeGuards|checkProfitLock|checkBreakevenStop|reentryCooldown|checkSpread|capitalPool|portfolioRisk|getLotQty|LOT_MULTIPLIER|commonTradeWindow|TRADE_EXPIRY_DAY_ONLY/.test(s));
  }
});
check("NIFTY sizes off its own GAP_RUNAWAY_LOTS × the NIFTY lot", () => {
  assert.ok(/GAP_RUNAWAY_LOTS/.test(paper)); assert.ok(/underlyingOf\("NIFTY"\)\.lotSize/.test(paper));
});
check("NIFTY strike is the exact ATM (strikeOverride — the global offsets do not apply)", () => {
  const calls = paper.match(/validateAndGetOptionSymbol\([^)]*\)/g) || [];
  assert.ok(calls.length >= 2); for (const c of calls) assert.ok(/strikeOverride:\s*_atmStrike\(/.test(c), c);
});
check("entry guards are synchronous before the first await (_entryPending set first)", () => {
  const fn = paper.slice(paper.indexOf("function _tryDayEntry"), paper.indexOf("function onCandleClose"));
  assert.ok(fn.length > 200, "could not isolate _tryDayEntry");
  assert.ok(fn.indexOf("ptState._entryPending = true") > 0);
  assert.ok(fn.indexOf("ptState._entryPending = true") < fn.indexOf("_fillEntry("));
  assert.ok(!/\bawait\b/.test(fn.replace(/\/\/.*$/gm, "")), "_tryDayEntry must not await");
});
check("one trade per day, restart-proof (day file counted on /start)", () => {
  assert.ok(/_taken >= 1/.test(paper)); assert.ok(/readDailyTrades\("gap_runaway", todayStr\)/.test(paper));
  assert.ok(/_priorTradesToday/.test(stk) && /_tradedToday/.test(stk));
});
check("restart-proof: a crash snapshot from today and a settled decision both block a second decision", () => {
  assert.ok(/loadGapRunawayPosition\(\)/.test(paper), "the /start check must read today's crash snapshot");
  assert.ok(/_loadDayDecision\(\)/.test(paper) && /_saveDayDecision\(\)/.test(paper), "the NIFTY day decision must persist");
  assert.ok(/_loadDay\(\)/.test(stk) && /_saveDay\(\)/.test(stk) && /st\._dayFinal/.test(stk), "the scanner's settled decisions must persist");
});
check("a fill re-checks the day and its own token after every await (a hung attempt can never open)", () => {
  const fe = paper.slice(paper.indexOf("async function _fillEntry"), paper.indexOf("function _tryDayEntry"));
  assert.ok(/ptState\._fillTok !== tok/.test(fe) && /ptState\._dayDone/.test(fe));
  assert.strictEqual((fe.match(/if \(_stale\(\)\)/g) || []).length, 2, "both awaits must be followed by _stale()");
});
check("the manual entry honours one trade per day", () => {
  const me = paper.slice(paper.indexOf('router.post("/manualEntry"'), paper.indexOf("function buildSessionTradeRows"));
  assert.ok(/One trade per day/.test(me) && /_priorTradesToday/.test(me));
});
check("the scanner holds a bigger gap's slot while its price is missing, and tests every unchecked trail candle", () => {
  assert.ok(/_slotsLeft\(\) - held <= 0/.test(stk) && /held\+\+/.test(stk));
  const ct = stk.slice(stk.indexOf("async function _checkTrail"), stk.indexOf("function _loop"));
  assert.ok(/for \(let i = 0; i < closed\.length; i\+\+\)/.test(ct), "every closed candle since the last check must be tested");
});
check("the open's history call is bounded and the tick fallback only trusts the first seconds of 09:15", () => {
  assert.ok(/OPEN_FETCH_TIMEOUT_MS/.test(paper) && /Promise\.race/.test(paper) && /OPEN_TICK_MAX_DELAY_S/.test(paper));
});
check("the stock scanner ranks by |gap %| and caps at MAX_TRADES", () => {
  assert.ok(/Math\.abs\(b\.signal\.gapPct/.test(stk)); assert.ok(/_slotsLeft\(\)/.test(stk)); assert.ok(/GAP_RUNAWAY_STK_MAX_TRADES/.test(stk));
});
check("the stale-session gate runs after rehydrate in both routes", () => {
  for (const s of [paper, stk]) assert.ok(/clearStaleSessionOnTradingDay/.test(s));
});
check("both routes register the shared history endpoints (and not /delete-session)", () => {
  for (const s of [paper, stk]) {
    assert.ok(/router\.post\("\/restore-session\/:date"/.test(s)); assert.ok(/router\.delete\("\/session\/:index"/.test(s));
    assert.ok(!/delete-session/.test(s));
  }
});
check("the harness is triple-gated and Zerodha", () => {
  assert.ok(/broker:\s*"zerodha"/.test(harn)); assert.ok(/GAP_RUNAWAY_LIVE_ENABLED/.test(harn));
  assert.ok(/liveDryRun\.isDryRun\(DRY_KEY\)/.test(harn)); assert.ok(/router\.isLiveHarness\s*=\s*true/.test(harn));
  assert.ok(/MODE_TAG\s*=\s*"GAP_RUNAWAY-PAPER"/.test(harn)); assert.ok(/mode:\s*'GAP_RUNAWAY-PAPER'/.test(paper));
});

// ─────────────────────────────────────────────────────────────────────────────
section("Wiring — shared files");

const tl = require("../src/utils/tradeLogger");
check("tradeLogger knows gap_runaway, gap_runaway-live and gap_runaway_stk", () => {
  for (const k of ["gap_runaway", "gap_runaway-live", "gap_runaway_stk"]) assert.ok(tl.filePathFor(k));
});
check("skipLogger knows both modes", () => {
  const sl = require("../src/utils/skipLogger");
  for (const k of ["gap_runaway", "gap_runaway_stk"]) assert.ok(sl.filePathFor(k, "2026-10-26"));
});
check("sharedSocketState: own slots, paper ⊥ live, parallel with everything else", () => {
  const sss = require("../src/utils/sharedSocketState");
  assert.ok(sss.canStart("GAP_RUNAWAY_PAPER", { reserve: false }).allowed);
  sss.setGapRunawayMode("GAP_RUNAWAY_PAPER");
  try {
    assert.ok(!sss.canStart("GAP_RUNAWAY_LIVE", { reserve: false }).allowed);
    assert.ok(sss.canStart("GAP_RUNAWAY_STK_PAPER", { reserve: false }).allowed);
    assert.ok(sss.isAnyActive());
  } finally { sss.clearGapRunawayMode(); }
  assert.ok(!sss.isGapRunawayActive());
});
check("notify groups both modes on their own TG keys", () => {
  const n = read("utils/notify.js");
  assert.ok(/return "GAP_RUNAWAY_STK"/.test(n) && /return "GAP_RUNAWAY"/.test(n));
  assert.ok(n.indexOf('return "GAP_RUNAWAY_STK"') < n.indexOf('return "GAP_RUNAWAY";'), "the scanner must be matched first");
});
check("both strategies are in STRATEGY_MODES (Start All) and ship ON", () => {
  const { STRATEGY_MODES } = require("../src/utils/sharedNav");
  for (const m of ["GAP_RUNAWAY", "GAP_RUNAWAY_STK"]) {
    const row = STRATEGY_MODES.find(r => r.mode === m);
    assert.ok(row, m); assert.strictEqual(row.envDefault, "true");
  }
});
check("app.js mounts the three routes and opens the read-only pages", () => {
  const a = read("app.js");
  for (const m of ['"/gap_runaway-paper"', '"/gap_runaway-live"', '"/gap_runaway_stk-paper"']) assert.ok(a.includes(`app.use(${m}`), m);
  for (const p of ["/gap_runaway-paper/status/data", "/gap_runaway_stk-paper/status/data", "/gap_runaway-live/status/data", "/gap_runaway-paper/view/", "/gap_runaway_stk-paper/download/"]) assert.ok(a.includes(`"${p}"`), p);
});
check("Settings exposes every key the engine and routes read, with matching defaults", () => {
  // settings.js does not export its schema — read the literal field lines, the
  // same way scripts/genEnvDocs.js does.
  const fields = new Map();
  for (const line of read("routes/settings.js").split("\n")) {
    const k = /\{\s*key:\s*"([A-Z0-9_]+)"/.exec(line); if (!k) continue;
    const d = /default:\s*"([^"]*)"/.exec(line);
    fields.set(k[1], { key: k[1], default: d ? d[1] : undefined });
  }
  const want = { EMA_LENGTH: "21", RSI_LENGTH: "10", RSI_UPPER: "90", RSI_LOWER: "10", MIN_GAP_PTS: "0", TRAIL_EMA_LENGTH: "21",
    EXIT_TF: "5", ENTRY_START: "09:15", ENTRY_END: "09:30", EOD_EXIT_TIME: "15:15", REFERENCE_URL: eng.REFERENCE_URL };
  for (const P of ["GAP_RUNAWAY", "GAP_RUNAWAY_STK"]) for (const [k, d] of Object.entries(want)) {
    const f = fields.get(`${P}_${k}`); assert.ok(f, `${P}_${k} missing`); assert.strictEqual(String(f.default), d, `${P}_${k}`);
  }
  for (const [k, d] of [["GAP_RUNAWAY_LOTS", "1"], ["GAP_RUNAWAY_CAPITAL", "100000"], ["GAP_RUNAWAY_STK_TRADE_AMOUNT", "100000"],
    ["GAP_RUNAWAY_STK_MAX_TRADES", "3"], ["GAP_RUNAWAY_STK_UNIVERSE", "FNO"], ["GAP_RUNAWAY_STK_CAPITAL", "300000"],
    ["GAP_RUNAWAY_MODE_ENABLED", "true"], ["GAP_RUNAWAY_STK_MODE_ENABLED", "true"], ["GAP_RUNAWAY_LIVE_ENABLED", "false"]]) {
    const f = fields.get(k); assert.ok(f, `${k} missing`); assert.strictEqual(String(f.default), d, k);
  }
  for (const g of ["GAP_RUNAWAY", "GAP_RUNAWAY_STK"]) for (const e of ["STARTED", "ENTRY", "EXIT", "DAYREPORT"]) assert.ok(fields.has(`TG_${g}_${e}`), `TG_${g}_${e}`);
});
check("both appear in the sidebar, and vanish when disabled", () => {
  const nav = require("../src/utils/sharedNav");
  const on = nav.buildSidebar("gapRunawayPaper", false);
  assert.ok(/\/gap_runaway-paper\/status/.test(on)); assert.ok(/\/gap_runaway_stk-paper\/status/.test(on));
  process.env.GAP_RUNAWAY_MODE_ENABLED = "false"; process.env.GAP_RUNAWAY_STK_MODE_ENABLED = "false";
  try {
    const off = nav.buildSidebar("dashboard", false);
    assert.ok(!/gap_runaway-paper/.test(off)); assert.ok(!/gap_runaway_stk-paper/.test(off));
    assert.ok(!nav.enabledStrategies().some(r => /^GAP_RUNAWAY/.test(r.mode)), "a disabled strategy must leave Start All");
  } finally { delete process.env.GAP_RUNAWAY_MODE_ENABLED; delete process.env.GAP_RUNAWAY_STK_MODE_ENABLED; }
  assert.ok(nav.enabledStrategies().some(r => r.mode === "GAP_RUNAWAY"));
});
check("the stock scanner's MIS charges are a real round trip (both legs billed)", () => {
  const { _misCharges } = require("../src/routes/gapRunawayStkPaper");
  const c = _misCharges("CE", 2500, 2550, 40);   // ₹1L buy, ₹1.02L sell
  assert.ok(c > 50 && c < 90, `charges ${c}`);
  assert.strictEqual(_misCharges("CE", null, 2550, 40), 0);
  assert.ok(_misCharges("PE", 2550, 2500, 40) > 0);
});

console.log(`\nGAP_RUNAWAY: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

#!/usr/bin/env node
/**
 * SIMPLE_9:30 — RULE INVARIANTS
 *
 *   node tests/simple930.regression.js
 *
 * Zero dependencies, zero framework, exits non-zero on failure. Nothing here
 * opens a socket, a broker connection or a session — every assertion runs on
 * pure functions with hand-built candles.
 *
 * The rules these assertions defend, in the operator's own words:
 *
 *   "exactly on 9:25 AM get the option chain, find the ITM strike nearest ₹180
 *    on the CALL side and on the PUT side, put those 2 in a watchlist.
 *    Whichever breaks ₹180 first — by 9:30, 9:35 at the latest — take entry
 *    immediately. Initial SL 20 points, and keep moving the 20-point SL as a
 *    trailing SL if the trade goes in a good direction. If the trade is not
 *    going above ₹220 or below ₹160 — i.e. it keeps trading sideways — exit at
 *    9:45 whatever it may be, profit or loss."
 *
 * Each group below pins one clause of that, plus the null/NaN guards that
 * decide whether a missing number silently becomes a price.
 */

process.env.TZ = process.env.TZ || "Asia/Calcutta";

const assert = require("assert");
const fs     = require("fs");
const path   = require("path");

const SRC  = path.join(__dirname, "../src");
const read = (rel) => fs.readFileSync(path.join(SRC, rel), "utf-8");
/** Prose that merely mentions code is not code. */
const decomment = (s) => s.split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

// Deterministic env, applied BEFORE the requires. Anything the developer's real
// .env holds for this strategy must not decide whether the suite passes.
for (const k of Object.keys(process.env)) if (k.startsWith("SIMPLE930_")) delete process.env[k];
Object.assign(process.env, {
  NIFTY_LOT_SIZE:     "75",
  LOT_MULTIPLIER:     "1",
  MAX_LOT_MULTIPLIER: "10",
  INSTRUMENT:         "NIFTY_OPTIONS",
  STRIKE_OFFSET_CE:   "0",
  STRIKE_OFFSET_PE:   "0",
});

const S  = require("../src/strategies/simple930");
const BT = require("../src/routes/simple930Backtest");
const PP = require("../src/routes/simple930Paper");

let pass = 0, fail = 0;
function section(t) { console.log(`\n${t}`); }
function check(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); pass++; }
  catch (e) { console.log(`  ❌ ${name}\n       ${e.message}`); fail++; }
}
/** Wipe every SIMPLE930_ key so one case cannot leak into the next. */
function freshEnv(over) {
  for (const k of Object.keys(process.env)) if (k.startsWith("SIMPLE930_")) delete process.env[k];
  Object.assign(process.env, over || {});
  return S.getConfig();
}

// ═══════════════════════════════════════════════════════════════════════════
section("Config — the shipped defaults ARE the rule");
check("09:25 select · 09:25–09:35 entry · 09:45 sideways · 15:15 EOD", () => {
  const c = freshEnv();
  assert.strictEqual(c.selectionMin,  9 * 60 + 25);
  assert.strictEqual(c.entryStartMin, 9 * 60 + 25);
  assert.strictEqual(c.entryEndMin,   9 * 60 + 35);
  assert.strictEqual(c.sidewaysMin,   9 * 60 + 45);
  assert.strictEqual(c.forcedExitMin, 15 * 60 + 15);
});
check("trigger ₹180 · box ₹160–₹220 · stop 20pt · trail 20pt", () => {
  const c = freshEnv();
  assert.strictEqual(c.triggerPremium, 180);
  assert.strictEqual(c.bandUp, 220);
  assert.strictEqual(c.bandDown, 160);
  assert.strictEqual(c.slPts, 20);
  assert.strictEqual(c.trailPts, 20);
  assert.strictEqual(c.trailEnabled, true);
});
check("the three optional guards ship OFF, so the default IS the rule", () => {
  const c = freshEnv();
  assert.strictEqual(c.maxPremiumDist, 0);
  assert.strictEqual(c.minPremium, 0);
  assert.strictEqual(c.sustainPolls, 1);
});
check("moving the trigger moves the whole box with it", () => {
  const c = freshEnv({ SIMPLE930_TRIGGER_PREMIUM: "200" });
  assert.strictEqual(c.bandUp, 240);
  assert.strictEqual(c.bandDown, 180);
});
check("both box offsets are independently configurable", () => {
  const c = freshEnv({ SIMPLE930_BAND_UP_OFFSET: "50", SIMPLE930_BAND_DOWN_OFFSET: "30" });
  assert.strictEqual(c.bandUp, 230);
  assert.strictEqual(c.bandDown, 150);
});
check("every clock key is configurable", () => {
  const c = freshEnv({
    SIMPLE930_SELECTION_TIME: "09:20", SIMPLE930_ENTRY_START: "09:30",
    SIMPLE930_ENTRY_END: "09:40", SIMPLE930_SIDEWAYS_CHECK: "10:00",
    SIMPLE930_FORCED_EXIT: "14:30",
  });
  assert.deepStrictEqual(
    [c.selectionMin, c.entryStartMin, c.entryEndMin, c.sidewaysMin, c.forcedExitMin],
    [560, 570, 580, 600, 870]);
});
check("a malformed HH:MM falls back to the default, never to midnight", () => {
  const c = freshEnv({ SIMPLE930_ENTRY_END: "9-35", SIMPLE930_FORCED_EXIT: "99:99" });
  assert.strictEqual(c.entryEndMin, 9 * 60 + 35);
  assert.strictEqual(c.forcedExitMin, 15 * 60 + 15);
});
check("garbage numbers fall back instead of disarming the stop", () => {
  const c = freshEnv({ SIMPLE930_SL_PTS: "0", SIMPLE930_TRAIL_PTS: "-5", SIMPLE930_TRIGGER_PREMIUM: "abc" });
  assert.strictEqual(c.slPts, 20);
  assert.strictEqual(c.trailPts, 20);
  assert.strictEqual(c.triggerPremium, 180);
});
check("the trail can be switched off", () => {
  assert.strictEqual(freshEnv({ SIMPLE930_TRAIL_ENABLED: "false" }).trailEnabled, false);
  assert.strictEqual(freshEnv({ SIMPLE930_TRAIL_ENABLED: "true" }).trailEnabled, true);
});
check("getConfig is never cached — a Settings save applies without a restart", () => {
  freshEnv();
  assert.strictEqual(S.getConfig().triggerPremium, 180);
  process.env.SIMPLE930_TRIGGER_PREMIUM = "150";
  assert.strictEqual(S.getConfig().triggerPremium, 150);
  freshEnv();
});

// ═══════════════════════════════════════════════════════════════════════════
section("The 09:25 ladder");
check("CE walks DOWN from the ATM and PE walks UP — a CALL is ITM below spot", () => {
  const l = S.buildCandidateStrikes(24350, freshEnv());
  assert.deepStrictEqual(l.filter(x => x.side === "CE").map(x => x.strike).slice(0, 3), [24350, 24300, 24250]);
  assert.deepStrictEqual(l.filter(x => x.side === "PE").map(x => x.strike).slice(0, 3), [24350, 24400, 24450]);
});
check("the ATM rung is labelled ATM and the rest ITM", () => {
  const l = S.buildCandidateStrikes(24350, freshEnv());
  assert.strictEqual(l.find(x => x.side === "CE" && x.strike === 24350).moneyness, "ATM");
  assert.strictEqual(l.find(x => x.side === "CE" && x.strike === 24300).moneyness, "ITM");
  assert.strictEqual(l.find(x => x.side === "PE" && x.strike === 24400).moneyness, "ITM");
});
check("ITM depth is configurable; 8 per side is the default", () => {
  assert.strictEqual(S.buildCandidateStrikes(24350, freshEnv()).filter(x => x.side === "CE").length, 9);
  assert.strictEqual(S.buildCandidateStrikes(24350, freshEnv({ SIMPLE930_SCAN_ITM_STRIKES: "3" })).filter(x => x.side === "CE").length, 4);
});
check("OTM rungs are OFF by default and appear when asked for", () => {
  assert.strictEqual(S.buildCandidateStrikes(24350, freshEnv()).some(x => x.moneyness === "OTM"), false);
  const l = S.buildCandidateStrikes(24350, freshEnv({ SIMPLE930_SCAN_ITM_STRIKES: "2", SIMPLE930_SCAN_OTM_STRIKES: "2" }));
  assert.deepStrictEqual(l.filter(x => x.side === "CE").map(x => x.strike), [24450, 24400, 24350, 24300, 24250]);
  assert.strictEqual(l.find(x => x.side === "CE" && x.strike === 24450).moneyness, "OTM");
});
check("a non-finite ATM yields no ladder rather than NaN strikes", () => {
  assert.deepStrictEqual(S.buildCandidateStrikes(null, freshEnv()), []);
  assert.deepStrictEqual(S.buildCandidateStrikes(NaN, freshEnv()), []);
});
check("optionSymbol builds the exact Fyers form", () => {
  assert.strictEqual(S.optionSymbol("26902", 24350, "CE"), "NSE:NIFTY2690224350CE");
});

// ═══════════════════════════════════════════════════════════════════════════
section("The 09:25 selection — one strike per side, nearest ₹180");
const LADDER = () => [
  { strike: 24350, side: "CE", ltp: 120, moneyness: "ATM" },
  { strike: 24300, side: "CE", ltp: 155, moneyness: "ITM" },
  { strike: 24250, side: "CE", ltp: 191, moneyness: "ITM" },
  { strike: 24200, side: "CE", ltp: 232, moneyness: "ITM" },
  { strike: 24350, side: "PE", ltp: 118, moneyness: "ATM" },
  { strike: 24400, side: "PE", ltp: 149, moneyness: "ITM" },
  { strike: 24450, side: "PE", ltp: 178, moneyness: "ITM" },
  { strike: 24500, side: "PE", ltp: 214, moneyness: "ITM" },
].map(r => ({ ...r, symbol: S.optionSymbol("26902", r.strike, r.side) }));

check("the nearest premium wins on each side", () => {
  const r = S.selectWatchlist(LADDER(), 24350, freshEnv());
  assert.strictEqual(r.ce.strike, 24250);   // |191-180| = 11 beats |155-180| = 25
  assert.strictEqual(r.pe.strike, 24450);   // |178-180| = 2
});
check("the candidate list is ordered nearest-first, so the UI table matches the pick", () => {
  const r = S.selectWatchlist(LADDER(), 24350, freshEnv());
  assert.strictEqual(r.candidates[0].strike, 24450);
  for (let i = 1; i < r.candidates.length; i++) assert.ok(r.candidates[i].dist >= r.candidates[i - 1].dist);
});
check("an exact tie breaks toward the money, and input order cannot change it", () => {
  const c = freshEnv();
  const rows = [
    { strike: 24300, side: "CE", ltp: 170, symbol: "a" },   // dist 10, 50 from ATM
    { strike: 24200, side: "CE", ltp: 190, symbol: "b" },   // dist 10, 150 from ATM
  ];
  assert.strictEqual(S.selectWatchlist(rows, 24350, c).ce.strike, 24300);
  assert.strictEqual(S.selectWatchlist(rows.slice().reverse(), 24350, c).ce.strike, 24300);
});
check("a rung with no premium is REPORTED missing, never priced at zero", () => {
  const rows = LADDER();
  rows[2].ltp = null;                        // the CE that would have won
  const r = S.selectWatchlist(rows, 24350, freshEnv());
  assert.strictEqual(r.ce.strike, 24300);
  assert.ok(r.notes.missing.some(m => m.strike === 24250 && m.side === "CE"));
});
check("a zero or negative premium counts as missing, never as ₹0", () => {
  const rows = LADDER(); rows[2].ltp = 0; rows[6].ltp = -3;
  const r = S.selectWatchlist(rows, 24350, freshEnv());
  assert.notStrictEqual(r.ce.strike, 24250);
  assert.notStrictEqual(r.pe.strike, 24450);
});
check("MAX_PREMIUM_DIST refuses a side that is nowhere near the trigger", () => {
  const r = S.selectWatchlist(LADDER(), 24350, freshEnv({ SIMPLE930_MAX_PREMIUM_DIST: "5" }));
  assert.strictEqual(r.ce, null);            // nearest CE is 11 away
  assert.strictEqual(r.pe.strike, 24450);    // nearest PE is 2 away
  assert.ok(r.notes.rejected.some(x => x.side === "CE"));
});
check("with that guard OFF the far side is still watched (the rule as written)", () => {
  const r = S.selectWatchlist(LADDER(), 24350, freshEnv());
  assert.ok(r.ce && r.pe);
});
check("MIN_PREMIUM drops cheap rungs before the pick is made", () => {
  const r = S.selectWatchlist(LADDER(), 24350, freshEnv({ SIMPLE930_MIN_PREMIUM: "160" }));
  assert.strictEqual(r.ce.strike, 24250);
  assert.ok(r.candidates.every(x => x.ltp >= 160));
});
check("an empty or non-array ladder returns nulls with a stated reason", () => {
  const r = S.selectWatchlist([], 24350, freshEnv());
  assert.strictEqual(r.ce, null);
  assert.strictEqual(r.pe, null);
  assert.ok(/no option quotes/.test(r.notes.reason));
  assert.strictEqual(S.selectWatchlist(null, 24350, freshEnv()).ce, null);
});

// ═══════════════════════════════════════════════════════════════════════════
section("The entry trigger");
const LEG = (ltp, strike) => ({ symbol: "sym" + strike, strike, ltp });
check("fires on the first leg STRICTLY above ₹180", () => {
  const v = S.evaluateTrigger({ ce: LEG(181, 24250), pe: LEG(175, 24450) }, freshEnv(), {});
  assert.strictEqual(v.fire, true);
  assert.strictEqual(v.leg, "CE");
  assert.strictEqual(v.ltp, 181);
});
check("exactly ₹180 is NOT a break", () => {
  assert.strictEqual(S.evaluateTrigger({ ce: LEG(180, 1), pe: LEG(180, 2) }, freshEnv(), {}).fire, false);
});
check("both legs above → the one further through the level wins", () => {
  const v = S.evaluateTrigger({ ce: LEG(186, 1), pe: LEG(191, 2) }, freshEnv(), {});
  assert.strictEqual(v.leg, "PE");
  assert.strictEqual(v.both, true);
});
check("a missing leg is simply not a candidate", () => {
  const v = S.evaluateTrigger({ ce: null, pe: LEG(200, 2) }, freshEnv(), {});
  assert.strictEqual(v.fire, true);
  assert.strictEqual(v.leg, "PE");
});
check("a null / NaN / undefined premium cannot fire the trigger", () => {
  const c = freshEnv();
  assert.strictEqual(S.evaluateTrigger({ ce: LEG(null, 1), pe: LEG(NaN, 2) }, c, {}).fire, false);
  assert.strictEqual(S.evaluateTrigger({ ce: LEG(undefined, 1), pe: null }, c, {}).fire, false);
});
check("no legs at all → no fire, and the reason names both sides", () => {
  const v = S.evaluateTrigger({}, freshEnv(), {});
  assert.strictEqual(v.fire, false);
  assert.ok(/CE —/.test(v.reason) && /PE —/.test(v.reason));
});
check("SUSTAIN_POLLS holds the entry until the level has been held N times", () => {
  const c = freshEnv({ SIMPLE930_SUSTAIN_POLLS: "3" });
  assert.strictEqual(S.evaluateTrigger({ ce: LEG(185, 1) }, c, { CE: 0 }).fire, false);
  assert.strictEqual(S.evaluateTrigger({ ce: LEG(185, 1) }, c, { CE: 1 }).fire, false);
  assert.strictEqual(S.evaluateTrigger({ ce: LEG(185, 1) }, c, { CE: 2 }).fire, true);
});
check("the default sustain of 1 enters on the very first quote above", () => {
  assert.strictEqual(S.evaluateTrigger({ ce: LEG(181, 1) }, freshEnv(), { CE: 0 }).fire, true);
});
check("the entry window is inclusive at both edges and shut outside them", () => {
  const c = freshEnv();
  assert.strictEqual(S.inEntryWindow(9 * 60 + 24, c), false);
  assert.strictEqual(S.inEntryWindow(9 * 60 + 25, c), true);
  assert.strictEqual(S.inEntryWindow(9 * 60 + 35, c), true);
  assert.strictEqual(S.inEntryWindow(9 * 60 + 36, c), false);
});

// ═══════════════════════════════════════════════════════════════════════════
section("Stop and trail");
check("the stop is a DISTANCE off the FILL — the rule's own 181 → 161", () => {
  const c = freshEnv();
  assert.strictEqual(S.computeInitialStop(181, c), 161);
  assert.strictEqual(S.computeInitialStop(186, c), 166);
  assert.strictEqual(S.computeInitialStop(220, c), 200);
});
check("a stop that would land at or below ZERO refuses the trade", () => {
  // Clamping to 0 was worse than useless: `_num(0)` is true so the entry guard
  // passed, and `ltp <= 0` can never be true for a live premium — the position
  // rode with its risk switched off and only 15:15 could close it. Reachable
  // whenever SL_PTS is at or above TRIGGER_PREMIUM.
  assert.strictEqual(S.computeInitialStop(12, freshEnv()), null, "a 12-20 stop must refuse, not clamp to 0");
  assert.strictEqual(S.computeInitialStop(20, freshEnv()), null, "exactly zero is not a stop");
  assert.strictEqual(S.computeInitialStop(20.5, freshEnv()), 0.5, "a positive stop is still returned");
  const tiny = freshEnv({ SIMPLE930_TRIGGER_PREMIUM: "10", SIMPLE930_SL_PTS: "20" });
  assert.strictEqual(S.computeInitialStop(11, tiny), null);
});
check("the sideways box floor can never go negative", () => {
  // "premium never left ₹-10–₹50" printed in a real exit reason.
  const c = freshEnv({ SIMPLE930_TRIGGER_PREMIUM: "10", SIMPLE930_BAND_DOWN_OFFSET: "20" });
  assert.strictEqual(c.bandDown, 0);
  assert.ok(c.bandDown >= 0);
});
check("an unusable fill yields NO stop, so the caller must refuse the trade", () => {
  const c = freshEnv();
  assert.strictEqual(S.computeInitialStop(null, c), null);
  assert.strictEqual(S.computeInitialStop(0, c), null);
  assert.strictEqual(S.computeInitialStop(NaN, c), null);
});
check("the trail follows the peak — the rule's own 190 / 200 / 220 walk", () => {
  const c = freshEnv();
  const init = S.computeInitialStop(181, c);
  assert.strictEqual(S.computeTrailStop(190, init, c), 170);
  assert.strictEqual(S.computeTrailStop(200, init, c), 180);
  assert.strictEqual(S.computeTrailStop(220, init, c), 200);
});
check("the trail RATCHETS — it never drops back below the initial stop", () => {
  const c = freshEnv();
  const init = S.computeInitialStop(181, c);   // 161
  assert.strictEqual(S.computeTrailStop(181, init, c), 161);
  assert.strictEqual(S.computeTrailStop(170, init, c), 161);
});
check("with the trail off the stop stays exactly where it started", () => {
  assert.strictEqual(S.computeTrailStop(400, 161, freshEnv({ SIMPLE930_TRAIL_ENABLED: "false" })), 161);
});
check("a separate trail distance is honoured", () => {
  assert.strictEqual(S.computeTrailStop(200, 161, freshEnv({ SIMPLE930_TRAIL_PTS: "10" })), 190);
});

// ═══════════════════════════════════════════════════════════════════════════
section("The 09:45 box");
check("touching an edge counts as leaving the box", () => {
  const c = freshEnv();
  assert.strictEqual(S.isExpanded(220, 175, c), true);
  assert.strictEqual(S.isExpanded(219.95, 175, c), false);
  assert.strictEqual(S.isExpanded(200, 160, c), true);
  assert.strictEqual(S.isExpanded(200, 160.05, c), false);
});
check("null peak / trough cannot fake an expansion", () => {
  assert.strictEqual(S.isExpanded(null, null, freshEnv()), false);
});

// ═══════════════════════════════════════════════════════════════════════════
section("exitCheck — the ONLY exit decision");
const POS = (over) => Object.assign({
  side: "CE", symbol: "s", stop: 161, initialStop: 161, peak: 181, trough: 181,
}, over);
check("the stop fires at or below its level", () => {
  const c = freshEnv();
  assert.strictEqual(S.exitCheck(POS(), 161, 9 * 60 + 40, c).kind, "STOP");
  assert.strictEqual(S.exitCheck(POS(), 160.5, 9 * 60 + 40, c).kind, "STOP");
  assert.strictEqual(S.exitCheck(POS(), 161.5, 9 * 60 + 40, c).exit, false);
});
check("a stop that has trailed reports as TRAIL, not STOP", () => {
  const v = S.exitCheck(POS({ stop: 200, peak: 220 }), 199, 10 * 60, freshEnv());
  assert.strictEqual(v.kind, "TRAIL");
  assert.ok(/Trailing stop/.test(v.reason));
});
check("the 09:45 exit fires only while the trade is still boxed", () => {
  const c = freshEnv();
  assert.strictEqual(S.exitCheck(POS({ peak: 210, trough: 170 }), 205, 9 * 60 + 45, c).kind, "SIDEWAYS");
  assert.strictEqual(S.exitCheck(POS({ peak: 225, trough: 170 }), 205, 9 * 60 + 45, c).exit, false);
});
check("before 09:45 a boxed trade is left alone", () => {
  assert.strictEqual(S.exitCheck(POS({ peak: 210, trough: 170 }), 205, 9 * 60 + 44, freshEnv()).exit, false);
});
check("the stop OUTRANKS the 09:45 exit on the same observation", () => {
  assert.strictEqual(S.exitCheck(POS({ peak: 210, trough: 170 }), 155, 9 * 60 + 45, freshEnv()).kind, "STOP");
});
check("a position opened AT/AFTER the check time is not closed by the box", () => {
  // Out of the box the windows cannot overlap (09:35 entry end vs 09:45 check),
  // but both are settable. Without this guard, widening ENTRY_END past
  // SIDEWAYS_CHECK closes every trade on its very first quote.
  const c = freshEnv({ SIMPLE930_ENTRY_END: "10:00" });
  const late = POS({ peak: 181, trough: 181, entryMin: 9 * 60 + 50 });
  assert.strictEqual(S.exitCheck(late, 181, 9 * 60 + 51, c).exit, false);
  // ...while a trade that DID run into the check is still closed
  const early = POS({ peak: 181, trough: 181, entryMin: 9 * 60 + 31 });
  assert.strictEqual(S.exitCheck(early, 181, 9 * 60 + 51, c).kind, "SIDEWAYS");
});
check("a Settings save cannot re-arm the 09:45 exit on an OPEN trade", () => {
  // The trade below already cleared a 220 box. Widening the box to 260 mid-trade
  // must not drag it back inside and close a winner the rule had released.
  const wide = freshEnv({ SIMPLE930_BAND_UP_OFFSET: "80" });   // box top now 260
  const pos = POS({ peak: 225, trough: 178, bandUp: 220, bandDown: 160, entryMin: 9 * 60 + 30, stop: 205 });
  assert.strictEqual(S.isExpanded(pos.peak, pos.trough, wide, pos), true, "the frozen box was ignored");
  assert.strictEqual(S.exitCheck(pos, 215, 9 * 60 + 46, wide).exit, false);
  // ...while a position carrying no frozen box still follows the live config
  const unfrozen = POS({ peak: 225, trough: 178, entryMin: 9 * 60 + 30, stop: 205 });
  assert.strictEqual(S.isExpanded(unfrozen.peak, unfrozen.trough, wide), false);
});
check("the frozen box is quoted in the exit reason, not the live one", () => {
  const wide = freshEnv({ SIMPLE930_BAND_UP_OFFSET: "80" });
  const pos = POS({ peak: 190, trough: 178, bandUp: 220, bandDown: 160, entryMin: 9 * 60 + 30 });
  const v = S.exitCheck(pos, 185, 9 * 60 + 46, wide);
  assert.strictEqual(v.kind, "SIDEWAYS");
  assert.ok(/₹160–₹220/.test(v.reason), `reason quotes the live box, not the trade's: ${v.reason}`);
});
check("a position with no entryMin keeps the old box behaviour", () => {
  const v = S.exitCheck(POS({ peak: 210, trough: 170 }), 205, 9 * 60 + 45, freshEnv());
  assert.strictEqual(v.kind, "SIDEWAYS");
});
check("EOD squares off whatever survived everything else", () => {
  assert.strictEqual(S.exitCheck(POS({ peak: 300, trough: 175, stop: 280 }), 290, 15 * 60 + 15, freshEnv()).kind, "EOD");
});
check("a NULL stop cannot exit on the first quote (the `ltp <= null` trap)", () => {
  const v = S.exitCheck(POS({ stop: null, initialStop: null, peak: 300, trough: 175 }), 250, 10 * 60, freshEnv());
  assert.strictEqual(v.exit, false);
});
check("a null or zero premium decides nothing at all", () => {
  const c = freshEnv();
  assert.strictEqual(S.exitCheck(POS(), null, 16 * 60, c).exit, false);
  assert.strictEqual(S.exitCheck(POS(), 0, 16 * 60, c).exit, false);
});
check("no position → no exit", () => {
  assert.strictEqual(S.exitCheck(null, 100, 16 * 60, freshEnv()).exit, false);
});
check("every exit branch names a rupee figure the operator can check", () => {
  const c = freshEnv();
  for (const v of [
    S.exitCheck(POS(), 155, 10 * 60, c),
    S.exitCheck(POS({ peak: 210, trough: 170 }), 205, 9 * 60 + 45, c),
    S.exitCheck(POS({ peak: 300, trough: 175, stop: 280 }), 290, 15 * 60 + 15, c),
  ]) assert.ok(/₹\d/.test(v.reason), `reason carries no rupee figure: ${v.reason}`);
});

// ═══════════════════════════════════════════════════════════════════════════
section("Paper route — quote attribution decides every price");
check("a quote is attributed STRICTLY by symbol", () => {
  const m = PP.attributeQuotes({ s: "ok", d: [{ n: "A", v: { lp: 10 } }, { n: "B", v: { lp: 20 } }] }, ["A", "B"]);
  assert.strictEqual(m.get("A").ltp, 10);
  assert.strictEqual(m.get("B").ltp, 20);
});
check("an unidentifiable row in a MULTI-symbol response is dropped, never guessed", () => {
  const m = PP.attributeQuotes({ s: "ok", d: [{ v: { lp: 999 } }, { n: "B", v: { lp: 20 } }] }, ["A", "B"]);
  assert.strictEqual(m.has("A"), false);
  assert.strictEqual(m.get("B").ltp, 20);
});
check("a single-symbol response with no symbol field is safely attributed", () => {
  assert.strictEqual(PP.attributeQuotes({ s: "ok", d: [{ v: { lp: 42 } }] }, ["A"]).get("A").ltp, 42);
});
check("a symbol we never asked for is ignored", () => {
  assert.strictEqual(PP.attributeQuotes({ s: "ok", d: [{ n: "Z", v: { lp: 5 } }] }, ["A"]).size, 0);
});
check("zero, negative and string premiums are all rejected", () => {
  const resp = { s: "ok", d: [{ n: "A", v: { lp: 0 } }, { n: "B", v: { lp: -1 } }, { n: "C", v: { lp: "12" } }] };
  assert.strictEqual(PP.attributeQuotes(resp, ["A", "B", "C"]).size, 0);
});
check("a failed or malformed response yields an empty map, not a throw", () => {
  assert.strictEqual(PP.attributeQuotes({ s: "no_data", d: [] }, ["A"]).size, 0);
  assert.strictEqual(PP.attributeQuotes(null, ["A"]).size, 0);
  assert.strictEqual(PP.attributeQuotes({ s: "ok" }, ["A"]).size, 0);
});
check("bid / ask ride along when the quote carries them", () => {
  const q = PP.attributeQuotes({ s: "ok", d: [{ n: "A", v: { lp: 10, bid: 9.5, ask: 10.5 } }] }, ["A"]).get("A");
  assert.strictEqual(q.bid, 9.5);
  assert.strictEqual(q.ask, 10.5);
});

// ═══════════════════════════════════════════════════════════════════════════
section("Backtest — one whole session, on hand-built 1-min bars");
// 2026-08-25 was a Tuesday. `min` is IST minutes-of-day.
const DAY_EPOCH = Math.floor(Date.parse("2026-08-25T00:00:00+05:30") / 1000);
const bar  = (min, o, h, l, c) => ({ time: DAY_EPOCH + min * 60, open: o, high: h, low: l, close: c });
const flat = (min, p) => bar(min, p, p, p, p);
const SEL  = 9 * 60 + 25, END = 15 * 60 + 30;
function mkDay(over) {
  const spotBars = [];
  for (let m = 9 * 60 + 15; m <= END; m++) spotBars.push(flat(m, 24350));
  return Object.assign({ dateStr: "2026-08-25", expiryCode: "26826", spotBars, ladder: [] }, over);
}
const mkLeg = (side, strike, bars) => ({ strike, side, steps: 1, moneyness: "ITM", symbol: S.optionSymbol("26826", strike, side), bars });
const QTY = 75;
const NOSLIP = { SIMPLE930_BT_SLIPPAGE_PTS: "0" };

check("a clean break → 20pt stop off the fill (the rule's 181 → 161)", () => {
  const c = freshEnv(NOSLIP);
  const ce = [flat(SEL, 178)];
  for (let m = SEL + 1; m <= END; m++) ce.push(flat(m, m === 9 * 60 + 30 ? 181 : 178));
  const pe = []; for (let m = SEL; m <= END; m++) pe.push(flat(m, 120));
  const { trade } = BT.simulateDay(mkDay({ ladder: [mkLeg("CE", 24250, ce), mkLeg("PE", 24450, pe)] }), c, QTY);
  assert.ok(trade, "expected a trade");
  assert.strictEqual(trade.side, "CE");
  assert.strictEqual(trade.ePrice, 181);
  assert.strictEqual(trade.sl, 161);
});
check("a bar that only TOUCHES ₹180 does not fill", () => {
  const c = freshEnv(NOSLIP);
  const ce = []; for (let m = SEL; m <= END; m++) ce.push(bar(m, 178, 180, 176, 178));
  const { trade, audit } = BT.simulateDay(mkDay({ ladder: [mkLeg("CE", 24250, ce)] }), c, QTY);
  assert.strictEqual(trade, null);
  assert.strictEqual(audit.outcome, "no_trigger");
});
check("a bar that OPENS above the trigger fills at the open, not at the trigger", () => {
  const c = freshEnv(NOSLIP);
  const ce = [flat(SEL, 178)];
  for (let m = SEL + 1; m <= END; m++) ce.push(bar(m, 195, 200, 190, 195));
  const { trade } = BT.simulateDay(mkDay({ ladder: [mkLeg("CE", 24250, ce)] }), c, QTY);
  assert.strictEqual(trade.ePrice, 195);
  assert.strictEqual(trade.sl, 175);
});
check("slippage is charged on BOTH sides, always adversely", () => {
  const c = freshEnv({ SIMPLE930_BT_SLIPPAGE_PTS: "2" });
  const ce = [flat(SEL, 178)];
  for (let m = SEL + 1; m <= END; m++) ce.push(flat(m, 181));
  const { trade } = BT.simulateDay(mkDay({ ladder: [mkLeg("CE", 24250, ce)] }), c, QTY);
  assert.strictEqual(trade.ePrice, 183);              // 181 + 2 paid up on the buy
  assert.ok(trade.xPrice <= 181 - 2 + 1e-9);          // and given up on the sell
});
check("the 09:45 sideways exit fires when the premium never left the box", () => {
  const c = freshEnv(NOSLIP);
  const ce = [flat(SEL, 178)];
  for (let m = SEL + 1; m <= END; m++) ce.push(bar(m, 190, 200, 185, 190));
  const { trade } = BT.simulateDay(mkDay({ ladder: [mkLeg("CE", 24250, ce)] }), c, QTY);
  assert.strictEqual(trade.exitKind, "SIDEWAYS");
  assert.strictEqual(trade.expanded, "no");
  assert.strictEqual(trade.xPrice, 190);              // the 09:45 bar's OPEN
});
check("a trade that touched ₹220 survives 09:45 and runs on the trail", () => {
  const c = freshEnv(NOSLIP);
  const ce = [flat(SEL, 178)];
  for (let m = SEL + 1; m <= END; m++) {
    if (m === SEL + 1)      ce.push(flat(m, 181));
    else if (m === 9 * 60 + 30) ce.push(bar(m, 200, 225, 200, 220));   // clears the box
    else if (m === 10 * 60)     ce.push(bar(m, 220, 220, 200, 200));   // gives back to the trail
    else                        ce.push(bar(m, 215, 218, 212, 215));
  }
  const { trade } = BT.simulateDay(mkDay({ ladder: [mkLeg("CE", 24250, ce)] }), c, QTY);
  assert.strictEqual(trade.expanded, "yes");
  assert.strictEqual(trade.exitKind, "TRAIL");
  assert.strictEqual(trade.xPrice, 205);              // peak 225 − 20
  assert.ok(trade.trailMoves > 0);
});
check("the stop is tested on the bar LOW before the trail is lifted from the HIGH", () => {
  const c = freshEnv(NOSLIP);
  const ce = [flat(SEL, 178)];
  for (let m = SEL + 1; m <= END; m++) {
    if (m === SEL + 1)      ce.push(flat(m, 181));
    else if (m === SEL + 2) ce.push(bar(m, 181, 260, 150, 200));       // spikes AND dives
    else                    ce.push(flat(m, 200));
  }
  const { trade } = BT.simulateDay(mkDay({ ladder: [mkLeg("CE", 24250, ce)] }), c, QTY);
  assert.strictEqual(trade.exitKind, "STOP");         // NOT a 240 trail — the loss books
  assert.strictEqual(trade.xPrice, 161);
});
check("a bar that opened below the stop fills at the OPEN, never at the better stop", () => {
  const c = freshEnv(NOSLIP);
  const ce = [flat(SEL, 178)];
  for (let m = SEL + 1; m <= END; m++) ce.push(m === SEL + 1 ? flat(m, 181) : bar(m, 140, 145, 138, 142));
  const { trade } = BT.simulateDay(mkDay({ ladder: [mkLeg("CE", 24250, ce)] }), c, QTY);
  assert.strictEqual(trade.xPrice, 140);
});
check("the entry bar's own low can stop the trade out — no free ride", () => {
  const c = freshEnv(NOSLIP);
  const ce = [flat(SEL, 178)];
  for (let m = SEL + 1; m <= END; m++) ce.push(m === SEL + 1 ? bar(m, 178, 185, 155, 160) : flat(m, 200));
  const { trade } = BT.simulateDay(mkDay({ ladder: [mkLeg("CE", 24250, ce)] }), c, QTY);
  assert.strictEqual(trade.ePrice, 180);              // intrabar cross fills at the trigger
  assert.strictEqual(trade.exitKind, "STOP");
  assert.strictEqual(trade.xPrice, 160);
});
check("the entry bar's OPEN printed BEFORE the fill and can never be the exit price", () => {
  // 09:26 opens at 150, rallies through the trigger (the fill at 180) and holds
  // 200 all day. The open is a PRE-ENTRY print: booking it as a "gapped through
  // the stop" fill exits at a price this trade could never have got. The honest
  // worst case is the bar's own low taking out the ₹160 stop.
  const c = freshEnv(NOSLIP);
  const ce = [flat(SEL, 178)];
  for (let m = SEL + 1; m <= END; m++) ce.push(m === SEL + 1 ? bar(m, 150, 190, 148, 185) : flat(m, 200));
  const { trade } = BT.simulateDay(mkDay({ ladder: [mkLeg("CE", 24250, ce)] }), c, QTY);
  assert.strictEqual(trade.ePrice, 180);
  assert.strictEqual(trade.sl, 160);
  assert.strictEqual(trade.exitKind, "STOP");
  assert.strictEqual(trade.xPrice, 160, "exited at the entry bar's open — a price that printed before the fill");
});
check("a bar with no usable OPEN cannot fill an entry — a NaN fill computes no stop", () => {
  const c = freshEnv(NOSLIP);
  const ce = [flat(SEL, 178)];
  for (let m = SEL + 1; m <= END; m++) {
    ce.push(m === SEL + 1 ? { time: DAY_EPOCH + m * 60, high: 190, low: 170, close: 185 } : flat(m, 150));
  }
  const { trade, audit } = BT.simulateDay(mkDay({ ladder: [mkLeg("CE", 24250, ce)] }), c, QTY);
  assert.strictEqual(trade, null, "filled off a bar with no open");
  assert.strictEqual(audit.outcome, "no_trigger");
});
check("a null or zero OPEN mid-trade decides nothing (the `open <= stop` trap)", () => {
  for (const badOpen of [null, 0]) {
    const c = freshEnv(NOSLIP);
    const ce = [flat(SEL, 178)];
    for (let m = SEL + 1; m <= END; m++) {
      if (m === SEL + 1)      ce.push(flat(m, 181));
      else if (m === SEL + 3) ce.push({ time: DAY_EPOCH + m * 60, open: badOpen, high: badOpen, low: badOpen, close: badOpen });
      else                    ce.push(flat(m, 200));
    }
    const { trade } = BT.simulateDay(mkDay({ ladder: [mkLeg("CE", 24250, ce)] }), c, QTY);
    assert.strictEqual(trade.exitKind, "SIDEWAYS", `open=${badOpen} invented an exit`);
    assert.strictEqual(trade.xPrice, 200, `open=${badOpen} priced the exit at ₹${trade.xPrice}`);
  }
});
check("a 09:25 index bar with no usable open is refused, not rounded to a NaN strike", () => {
  const { trade, audit } = BT.simulateDay(
    mkDay({ spotBars: [{ time: DAY_EPOCH + SEL * 60, open: null, high: null, low: null, close: null }] }),
    freshEnv(NOSLIP), QTY);
  assert.strictEqual(trade, null);
  assert.ok(/no usable open|ATM strike cannot be derived/.test(audit.note), `unhelpful note: ${audit.note}`);
});
check("the backtest mirrors the guard: a late entry is not boxed out at once", () => {
  const c = freshEnv({ ...NOSLIP, SIMPLE930_ENTRY_START: "09:50", SIMPLE930_ENTRY_END: "10:00" });
  const ce = [flat(SEL, 178)];
  for (let m = SEL + 1; m <= END; m++) ce.push(flat(m, m >= 9 * 60 + 50 ? 185 : 178));
  const { trade } = BT.simulateDay(mkDay({ ladder: [mkLeg("CE", 24250, ce)] }), c, QTY);
  assert.ok(trade, "expected a trade");
  assert.notStrictEqual(trade.exitKind, "SIDEWAYS");
  assert.strictEqual(trade.exitKind, "EOD");
});
check("EOD squares off a runner that cleared the box and never gave back the trail", () => {
  const c = freshEnv(NOSLIP);
  const ce = [flat(SEL, 178)];
  let px = 236;
  for (let m = SEL + 1; m <= END; m++) {
    if (m === SEL + 1)      ce.push(flat(m, 181));                  // entry
    else if (m === SEL + 2) ce.push(bar(m, 181, 235, 181, 235));    // clears ₹220 → survives 09:45
    // monotonic grind up: the low never reaches peak−20, so the trail never fires
    else { ce.push(bar(m, px, px + 1, px, px + 1)); px += 1; }
  }
  const { trade } = BT.simulateDay(mkDay({ ladder: [mkLeg("CE", 24250, ce)] }), c, QTY);
  assert.strictEqual(trade.expanded, "yes");
  assert.strictEqual(trade.exitKind, "EOD");
  assert.ok(trade.pnl > 0);
});
check("a PROFITABLE trade that never touched \u20b9220 is still closed at 09:45", () => {
  // The rule is explicit: sideways means it did not leave the box, whatever the
  // P&L. A +19pt trade that peaked at \u20b9201 is closed all the same.
  const c = freshEnv(NOSLIP);
  const ce = [flat(SEL, 178)];
  let px = 181;
  for (let m = SEL + 1; m <= END; m++) { ce.push(bar(m, px, px + 1, px - 0.5, px + 1)); px += 1; }
  const { trade } = BT.simulateDay(mkDay({ ladder: [mkLeg("CE", 24250, ce)] }), c, QTY);
  assert.strictEqual(trade.exitKind, "SIDEWAYS");
  assert.strictEqual(trade.expanded, "no");
  assert.ok(trade.peak < 220, `peak ${trade.peak} should never have reached the box top`);
  assert.ok(trade.pnl > 0, "this one happens to be a winner, and is closed anyway");
});
check("whichever leg is further through the level is the one bought", () => {
  const c = freshEnv(NOSLIP);
  const ce = [flat(SEL, 178)], pe = [flat(SEL, 179)];
  for (let m = SEL + 1; m <= END; m++) { ce.push(flat(m, 185)); pe.push(flat(m, 195)); }
  const { trade } = BT.simulateDay(mkDay({ ladder: [mkLeg("CE", 24250, ce), mkLeg("PE", 24450, pe)] }), c, QTY);
  assert.strictEqual(trade.side, "PE");
});
check("a whipsaw session still yields exactly one trade, and it is the FIRST break", () => {
  // simulateDay structurally returns one trade, so the assertion worth making is
  // that it is the first break of the window and not a later, better-looking one.
  const c = freshEnv(NOSLIP);
  const ce = [flat(SEL, 178)];
  for (let m = SEL + 1; m <= END; m++) ce.push(bar(m, 181, 190, 155, 181));
  const { trade } = BT.simulateDay(mkDay({ ladder: [mkLeg("CE", 24250, ce)] }), c, QTY);
  assert.ok(trade);
  assert.strictEqual(trade.entry.split(", ")[1], "09:26:00", "did not take the first bar that broke the level");
});
check("the ONE-trade-a-day cap survives a /stop then /start inside the window", () => {
  // /start calls _freshState(), which zeroes tradesTaken, and the JSONL
  // rehydrate only runs at module load — so without a day guard the operator
  // gets a second trade on a strategy whose whole rule is one.
  const src = decomment(read("routes/simple930Paper.js"));
  assert.ok(/_dayGuard/.test(src), "no same-day trade guard — a restart re-arms the day");
  assert.ok(/state\.tradesTaken\s*=\s*_dayGuard\.tradesTaken/.test(src), "/start does not restore the day's spent budget");
  assert.ok(/state\.dayClosed\s*=\s*_dayGuard\.dayClosed/.test(src), "/start does not restore a closed day");
  // and the guard must NOT be read back from disk, or a same-day replay would
  // close the day at once and produce zero trades.
  const guard = src.slice(src.indexOf("let _dayGuard"), src.indexOf("let state = _freshState()"));
  assert.ok(!/readDailyTrades/.test(guard), "the day guard reads the day file — that would break a same-day replay");
  assert.ok(/state\.tradesTaken >= _maxDailyTrades\(\)/.test(src), "the entry path does not enforce the cap");
});
check("no option data is reported as UNFETCHABLE, not as a flat day", () => {
  const { trade, audit } = BT.simulateDay(mkDay({ ladder: [mkLeg("CE", 24250, [])] }), freshEnv(), QTY);
  assert.strictEqual(trade, null);
  assert.strictEqual(audit.outcome, "no_data");
  assert.ok(/delisted|token/.test(audit.note));
});
check("a missing 09:25 index bar is reported rather than guessed", () => {
  const { trade, audit } = BT.simulateDay(mkDay({ spotBars: [flat(9 * 60 + 30, 24350)] }), freshEnv(), QTY);
  assert.strictEqual(trade, null);
  assert.ok(/no NIFTY index bar/.test(audit.note));
});
check("the audit names the picked strikes on both sides and why nothing traded", () => {
  const c = freshEnv(NOSLIP);
  const ce = [], pe = [];
  for (let m = SEL; m <= END; m++) { ce.push(flat(m, 176)); pe.push(flat(m, 179)); }
  const { audit } = BT.simulateDay(mkDay({ ladder: [mkLeg("CE", 24250, ce), mkLeg("PE", 24450, pe)] }), c, QTY);
  assert.strictEqual(audit.ce.strike, 24250);
  assert.strictEqual(audit.pe.strike, 24450);
  assert.strictEqual(audit.outcome, "no_trigger");
  assert.ok(/peaked/.test(audit.note));
});
check("changing the trigger changes which day trades — config is live in the backtest too", () => {
  const build = () => { const a = []; for (let m = SEL; m <= END; m++) a.push(flat(m, 176)); return a; };
  const d = () => mkDay({ ladder: [mkLeg("CE", 24250, build())] });
  assert.strictEqual(BT.simulateDay(d(), freshEnv(NOSLIP), QTY).trade, null);
  assert.ok(BT.simulateDay(d(), freshEnv({ ...NOSLIP, SIMPLE930_TRIGGER_PREMIUM: "170" }), QTY).trade);
});
check("changing the entry window changes whether a late break is taken", () => {
  const build = () => {
    const a = [flat(SEL, 170)];
    for (let m = SEL + 1; m <= END; m++) a.push(flat(m, m >= 9 * 60 + 40 ? 190 : 170));
    return a;
  };
  const d = () => mkDay({ ladder: [mkLeg("CE", 24250, build())] });
  assert.strictEqual(BT.simulateDay(d(), freshEnv(NOSLIP), QTY).trade, null);
  assert.ok(BT.simulateDay(d(), freshEnv({ ...NOSLIP, SIMPLE930_ENTRY_END: "09:45" }), QTY).trade);
});
check("Zerodha statutory charges are actually deducted from the P&L", () => {
  const c = freshEnv(NOSLIP);
  const ce = [flat(SEL, 178)];
  for (let m = SEL + 1; m <= END; m++) ce.push(flat(m, 181));
  const { trade } = BT.simulateDay(mkDay({ ladder: [mkLeg("CE", 24250, ce)] }), c, QTY);
  assert.ok(trade.charges > 0, "charges should be positive");
  assert.strictEqual(trade.pnl, parseFloat(((trade.xPrice - trade.ePrice) * QTY - trade.charges).toFixed(2)));
  assert.strictEqual(trade.broker, "zerodha");
});
check("the trade row carries every field the backtest table reads", () => {
  const c = freshEnv(NOSLIP);
  const ce = [flat(SEL, 178)];
  for (let m = SEL + 1; m <= END; m++) ce.push(flat(m, 181));
  const { trade } = BT.simulateDay(mkDay({ ladder: [mkLeg("CE", 24250, ce)] }), c, QTY);
  for (const k of ["entry", "exit", "ePrice", "xPrice", "sl", "side", "pnl", "entryReason", "reason", "entryTs", "exitTs"]) {
    assert.ok(trade[k] !== undefined, `missing field ${k}`);
  }
  assert.ok(/^\d{2}\/\d{2}\/\d{4}, \d{2}:\d{2}:\d{2}$/.test(trade.entry), `bad entry timestamp: ${trade.entry}`);
});

// ═══════════════════════════════════════════════════════════════════════════
section("Backtest — range and bar helpers");
check("weekends are dropped and the range is clamped to today", () => {
  assert.deepStrictEqual(BT.tradingDaysIn("2026-08-22", "2026-08-31", "2026-08-26"),
    ["2026-08-24", "2026-08-25", "2026-08-26"]);
});
check("a range entirely in the future yields no sessions", () => {
  assert.deepStrictEqual(BT.tradingDaysIn("2026-09-01", "2026-09-05", "2026-08-26"), []);
});
check("a malformed range yields no sessions rather than throwing", () => {
  assert.deepStrictEqual(BT.tradingDaysIn("nope", "2026-08-26", "2026-08-26"), []);
});
check("barAtMinute finds the bar covering an IST minute, and nothing else", () => {
  const bars = [flat(SEL - 1, 1), flat(SEL, 2), flat(SEL + 1, 3)];
  assert.strictEqual(BT.barAtMinute(bars, SEL).open, 2);
  assert.strictEqual(BT.barAtMinute(bars, SEL + 2), null);
  assert.strictEqual(BT.barAtMinute(null, 1), null);
});
check("byDay groups by IST calendar day", () => {
  const m = BT.byDay([flat(SEL, 1), { time: DAY_EPOCH + 86400 + 9 * 3600, open: 2, high: 2, low: 2, close: 2 }]);
  assert.strictEqual(m.size, 2);
  assert.ok(m.has("2026-08-25"));
});

// ═══════════════════════════════════════════════════════════════════════════
section("Single source of truth — no rule maths outside the engine");
check("neither route compares against a literal 180 / 220 / 160", () => {
  for (const f of ["routes/simple930Paper.js", "routes/simple930Backtest.js"]) {
    const src = decomment(read(f));
    assert.ok(!/[<>]=?\s*180\b/.test(src), `${f} compares against a literal 180`);
    assert.ok(!/[<>]=?\s*220\b/.test(src), `${f} compares against a literal 220`);
    assert.ok(!/[<>]=?\s*160\b/.test(src), `${f} compares against a literal 160`);
  }
});
check("both routes read their levels from the engine's getConfig()", () => {
  for (const f of ["routes/simple930Paper.js", "routes/simple930Backtest.js"]) {
    assert.ok(/strategy\.getConfig\(\)/.test(read(f)), `${f} never calls getConfig()`);
  }
});
check("the live harness re-implements no rule at all", () => {
  const src = read("routes/simple930LiveHarness.js");
  assert.ok(!/computeInitialStop|computeTrailStop|evaluateTrigger|exitCheck|selectWatchlist/.test(src));
});
check("live orders stay triple-gated (own switch + global dry-run + hold-back)", () => {
  const src = decomment(read("routes/simple930LiveHarness.js"));
  assert.ok(/liveDryRun\.isDryRun\("SIMPLE930"\)/.test(src), "does not consult the shared dry-run gate");
  assert.ok(/SIMPLE930_LIVE_ENABLED/.test(src), "does not check its own live switch");
  assert.ok(/zerodhaBroker\.isAuthenticated\(\)/.test(src), "does not require broker auth for real orders");
});
check("the live-harness log key matches tradeLogger's key character for character", () => {
  const harness = read("routes/simple930LiveHarness.js");
  const m = /liveLogKey:\s*"([^"]+)"/.exec(harness);
  assert.ok(m, "no liveLogKey in the harness");
  const logger = read("utils/tradeLogger.js");
  assert.ok(logger.includes(`"${m[1]}"`), `tradeLogger has no entry for "${m[1]}" — every live trade would be silently dropped`);
});
check("the paper route persists and clears its position snapshot", () => {
  const src = decomment(read("routes/simple930Paper.js"));
  assert.ok(/saveSimple930Position/.test(src));
  assert.ok(/clearSimple930Position/.test(src));
});
check("a 09:25 ladder that quoted NOTHING retries instead of killing the day", () => {
  // A thrown quote error already retried; a { s:"no_data" } response — an expired
  // token, a hiccup — used to freeze an empty watchlist for the whole session.
  const src = decomment(read("routes/simple930Paper.js"));
  const sel = src.slice(src.indexOf("async function runSelection"), src.indexOf("const ENTRY_RETRY_MS"));
  assert.ok(/quoted === 0/.test(sel), "an all-empty ladder is still treated as a decision");
  // It must bail BEFORE the "neither side produced a usable strike" close — that
  // close is a real decision about quoted prices, and an empty ladder has none.
  // (The earlier close, for an unresolvable expiry, IS a decision and stays.)
  const zeroIdx = sel.indexOf("quoted === 0");
  const strikeCloseIdx = sel.indexOf("Neither side produced a usable strike");
  assert.ok(zeroIdx > -1, "no empty-ladder guard");
  assert.ok(strikeCloseIdx > zeroIdx, "the empty-ladder retry runs after the day is already closed");
  assert.ok(!/state\.selection = sel/.test(sel.slice(0, zeroIdx)), "the selection is frozen before the emptiness check");
});
check("the backtest reuses the engine's IST helpers rather than its own copy", () => {
  // The engine header forbids routes re-deriving IST arithmetic; two copies that
  // agree today are two that can drift tomorrow.
  const src = decomment(read("routes/simple930Backtest.js"));
  assert.ok(/_istMins\s*=\s*strategy\._utcSecToIstMins/.test(src));
  assert.ok(/_istDayStr\s*=\s*strategy\._istDateStr/.test(src));
  assert.ok(!/function _istMins/.test(src), "the backtest still defines its own IST minute helper");
});
check("the backtest DISCLOSES that it takes at most one trade a session", () => {
  // simulateDay returns one trade unconditionally, so raising MAX_DAILY_TRADES
  // makes it report FEWER entries than paper without saying so.
  const src = read("routes/simple930Backtest.js");
  assert.ok(/MAX_DAILY_TRADES is set to/.test(src), "the results page never mentions the divergence");
});
check("the backtest's recorded peak/trough include the bar it exited on", () => {
  // The three open-priced exit branches break before folding their bar in, so
  // the extremes stopped one bar short — paper folds the exiting tick in.
  const c = freshEnv(NOSLIP);
  const ce = [flat(SEL, 178)];
  for (let m = SEL + 1; m <= END; m++) {
    if (m === SEL + 1) ce.push(flat(m, 181));
    else if (m === SEL + 2) ce.push(bar(m, 140, 145, 138, 142));   // gaps through the stop
    else ce.push(flat(m, 142));
  }
  const { trade } = BT.simulateDay(mkDay({ ladder: [mkLeg("CE", 24250, ce)] }), c, QTY);
  assert.strictEqual(trade.xPrice, 140);
  assert.ok(trade.trough <= 140, `trough ${trade.trough} excludes the exit price 140`);
});
check("the backtest DISCLOSES that it cannot model SUSTAIN_POLLS", () => {
  // "N consecutive quotes above the trigger" has no meaning on a 1-min bar, so
  // the backtest over-counts entries when it is set. Silence would be the bug.
  const src = read("routes/simple930Backtest.js");
  assert.ok(/SUSTAIN_POLLS is set to/.test(src), "the results page never mentions the divergence");
  assert.ok(/cfg\.sustainPolls > 1/.test(src), "the disclosure is not conditional on the setting");
});
check("every config field getConfig() returns is actually read somewhere", () => {
  const cfg = S.getConfig();
  const hay = ["strategies/simple930.js", "routes/simple930Paper.js",
               "routes/simple930Backtest.js", "routes/simple930LiveHarness.js",
               "../tools/genSimple930GuideData.js"]
    .map(f => { try { return f.startsWith("../") ? fs.readFileSync(path.join(__dirname, f.slice(3)), "utf-8") : read(f); } catch (_) { return ""; } })
    .join("\n");
  const dead = Object.keys(cfg).filter(k => !new RegExp(`\\.${k}\\b`).test(hay));
  assert.deepStrictEqual(dead, [], `getConfig() returns fields nothing reads: ${dead.join(", ")}`);
});
check("_checkExits judges the box the SAME way exitCheck does", () => {
  // The exit froze the box to the trade; the flag did not. A Settings change
  // mid-trade made the page, the decision trail and the crash snapshot all say
  // "the band broke" while the engine still closed the trade at 09:45.
  const src = decomment(read("routes/simple930Paper.js"));
  assert.ok(/isExpanded\(pos\.peak, pos\.trough, cfg, pos\)/.test(src),
    "_checkExits calls isExpanded without the position — the flag and the exit can disagree");
  // and prove the two forms really do differ, so the assertion above is not cosmetic
  const wide = freshEnv({ SIMPLE930_BAND_UP_OFFSET: "10" });
  const pos = { peak: 200, trough: 178, bandUp: 220, bandDown: 160 };
  assert.strictEqual(S.isExpanded(pos.peak, pos.trough, wide), true);
  assert.strictEqual(S.isExpanded(pos.peak, pos.trough, wide, pos), false);
});
check("the day budget is seeded at MODULE LOAD, not only on /stop then /start", () => {
  // /start zeroes tradesTaken, and every deploy restarts the process — so a
  // guard that only survived a session restart let a PM2 reload at 09:29 buy a
  // second time.
  const src = decomment(read("routes/simple930Paper.js"));
  const load = src.slice(src.indexOf("rehydrateSessionFromJsonl();"), src.indexOf("function weeklyPnl"));
  assert.ok(/_syncDayGuard\(\)/.test(load), "the guard is never seeded from the module-load rehydrate");
  assert.ok(/!state\._staleSession/.test(load), "a rehydrated PREVIOUS-day session would spend today's budget");
  // ...and a replay must ignore it, or replaying a day that traded books nothing
  assert.ok(/isReplayInProgress/.test(src), "/start does not exempt a replay from the day guard");
});
check("a stale premium raises an alarm and marks the exit it prices", () => {
  // Entry refuses a stale quote; an exit cannot — in LIVE the square-off order
  // still goes out and fills at the real price. So the exits keep running, the
  // operator is told, and the RECORD says the price was old.
  const src = decomment(read("routes/simple930Paper.js"));
  assert.ok(/quoteStale/.test(src), "no stale-premium watchdog on the exit path");
  assert.ok(/sendIfMaster/.test(src), "a stale feed raises no alert");
  assert.ok(/exitPriceStale/.test(src), "a stale-priced exit is not marked on the trade record");
  assert.ok(/_staleQuoteAlertMs/.test(src), "the stale alert is not throttled");
});
check("sustain counters reset BEFORE the entry-retry backoff returns", () => {
  const src = decomment(read("routes/simple930Paper.js"));
  const fn = src.slice(src.indexOf("async function evaluateEntry"), src.indexOf("async function simulateBuy"));
  const reset = fn.indexOf("state.sustain[side] = 0");
  const backoff = fn.indexOf("ENTRY_RETRY_MS) return");
  assert.ok(reset > -1 && backoff > -1, "could not locate both");
  assert.ok(reset < backoff, "a leg dipping below the trigger during the backoff keeps its streak");
});
check("the stale-premium skip row is throttled, not written once a poll", () => {
  // At a 1s poll a dead quote feed would otherwise bury the day's real skips
  // under hundreds of copies of the same row.
  const src = decomment(read("routes/simple930Paper.js"));
  const blk = src.slice(src.indexOf("_ltpStaleMs()"), src.indexOf("state._entryInFlight = true"));
  assert.ok(/_staleSkipLoggedMs/.test(blk), "the stale-premium skip row has no throttle");
});
check("the paper route clears a stale previous-day session on a trading day", () => {
  assert.ok(/staleSessionGate/.test(read("routes/simple930Paper.js")));
});
check("every entry guard is synchronous — no await before the position is claimed", () => {
  const src = read("routes/simple930Paper.js");
  const fn = src.slice(src.indexOf("async function evaluateEntry"), src.indexOf("async function simulateBuy"));
  const firstAwait = fn.indexOf("await");
  const guards = fn.indexOf("state._entryInFlight = true");
  assert.ok(guards > -1, "no in-flight latch found");
  assert.ok(firstAwait === -1 || guards < firstAwait, "an await runs before the in-flight latch is set — concurrent polls could double-enter");
});
check("a session that ended DURING the fill cannot still open the position", () => {
  // The entry re-quote is the only await in the buy path, and /stop (or the
  // 15:30 auto-stop) can land inside it. Committing afterwards leaves a real
  // broker order with no poll chain left to trail it, stop it or square it off.
  const src = decomment(read("routes/simple930Paper.js"));
  const fn  = src.slice(src.indexOf("async function simulateBuy"), src.indexOf("function simulateSell"));
  const firstAwait = fn.indexOf("await");
  const guard      = fn.search(/state\._sessionId\s*!==|!state\.running/);
  const claim      = fn.indexOf("state.position = pos");
  assert.ok(firstAwait > -1 && claim > -1, "simulateBuy no longer awaits / claims a position");
  assert.ok(guard > -1, "no session re-check after the fill's await — a /stop mid-fill would orphan the order");
  assert.ok(guard > firstAwait && guard < claim, "the session re-check must sit between the re-quote and the position claim");
});

// ═══════════════════════════════════════════════════════════════════════════
section("Wiring invariants — the parts that rot silently");
check("sharedSocketState keeps paper and live mutually exclusive", () => {
  const sss = require("../src/utils/sharedSocketState");
  sss.clearSimple930();
  assert.strictEqual(sss.canStart("SIMPLE930_PAPER").allowed, true);
  sss.setSimple930Active("SIMPLE930_PAPER");
  assert.strictEqual(sss.isSimple930Active(), true);
  assert.strictEqual(sss.getSimple930Mode(), "SIMPLE930_PAPER");
  assert.strictEqual(sss.isAnyActive(), true);
  assert.strictEqual(sss.canStart("SIMPLE930_LIVE").allowed, false);
  assert.strictEqual(sss.canStart("SIMPLE930_PAPER").allowed, false);
  sss.clearSimple930();
  assert.strictEqual(sss.isAnyActive(), false);
});
check("the capital pool routes this strategy to the ZERODHA pool", () => {
  const src = decomment(read("utils/capitalPool.js"));
  const m = /simple930:\s*\{[^}]*broker:\s*"([a-z]+)"/.exec(src);
  assert.ok(m, "no simple930 row in capitalPool.STRATEGIES — check/block/release would be silent no-ops");
  assert.strictEqual(m[1], "zerodha");
  assert.ok(/simple930_paper_trades\.json/.test(src));
});
check("the portfolio-wide daily cap counts this strategy", () => {
  assert.ok(/"simple930"/.test(decomment(read("utils/portfolioRisk.js"))));
});
check("skip and trade loggers both know the mode", () => {
  const skip = require("../src/utils/skipLogger");
  const trade = require("../src/utils/tradeLogger");
  assert.doesNotThrow(() => skip.filePathFor("simple930", "2026-01-01"));
  assert.doesNotThrow(() => trade.filePathFor("simple930"));
  assert.doesNotThrow(() => trade.filePathFor("simple930-live"));
  assert.doesNotThrow(() => trade.dailyFilePathFor("simple930-live", "2026-01-01"));
});
check("Telegram routes this strategy's alerts to its own group", () => {
  const notify = require("../src/utils/notify");
  assert.strictEqual(notify.modeGroup("SIMPLE930-PAPER"), "SIMPLE930");
  assert.strictEqual(notify.modeGroup("SIMPLE930-LIVE"), "SIMPLE930");
  assert.strictEqual(notify.modeGroup("SIMPLE930-LIVE (DRY-RUN)"), "SIMPLE930");
  // and the plain "PAPER" tag must still belong to EMA_RSI_ST, not to us
  assert.strictEqual(notify.modeGroup("PAPER"), "EMA_RSI_ST");
});
check("snapshot-mode replay pins this strategy's settings", () => {
  assert.ok(/\/\^SIMPLE930_\//.test(read("utils/tickRecorder.js")),
    "SIMPLE930_ is not in tickRecorder's settings-snapshot whitelist — a snapshot replay would silently use TODAY's config");
});
check("replay knows the mode, its module and its canonical trade file", () => {
  const replay = require("../src/services/tickReplay");
  assert.ok("simple930-paper" in replay._internals.MODE_TO_MODULE);
  assert.ok(/"simple930-paper":\s*"simple930_paper_trades\.json"/.test(read("services/tickReplay.js")));
});
check("replay stubs BOTH of this strategy's sharedSocketState mutators", () => {
  // A mutator the harness forgets to stub lets a replay leak the real mutex and
  // leave the strategy permanently unstartable.
  const src = read("services/tickReplay.js");
  assert.ok((src.match(/setSimple930Active/g) || []).length >= 3, "setSimple930Active is not saved+stubbed+restored");
  assert.ok((src.match(/clearSimple930/g) || []).length >= 3, "clearSimple930 is not saved+stubbed+restored");
});
check("replay does NOT mirror a per-strategy expiry key nothing reads", () => {
  const src = read("services/tickReplay.js");
  const prefixMap = src.slice(src.indexOf("_MODE_TO_ENV_PREFIX = {"), src.indexOf("// ── Market-context expiry resolution"));
  assert.ok(!/"simple930-paper":\s*"/.test(prefixMap),
    "simple930-paper is in _MODE_TO_ENV_PREFIX — replay would honour a SIMPLE930_OPTION_EXPIRY_* key that paper ignores");
});
check("the replay quote stub answers for EVERY requested symbol", () => {
  // This strategy quotes ~18 ladder symbols in one call. A stub that answered
  // only for symbols[0] could never reproduce the 09:25 pick.
  const src = read("services/tickReplay.js");
  const stub = src.slice(src.indexOf("fyers.getQuotes = async function"), src.indexOf("fyers.getHistory = async function"));
  assert.ok(/for \(const sym of list\)/.test(stub), "the getQuotes stub does not iterate the requested symbols");
  assert.ok(/n: sym/.test(stub), "the getQuotes stub does not label rows with their symbol — multi-symbol readers drop unlabelled rows");
  assert.ok(/no_data/.test(stub), "the getQuotes stub lost its empty-result shape");
});
check("every read-only page of this strategy is in app.js OPEN_PATHS/PREFIXES", () => {
  // With API_SECRET set, anything missed returns a raw 403 to a browser
  // navigation, because a navigation carries no secret.
  const app = read("app.js");
  for (const p of [
    "/simple930-paper/status", "/simple930-paper/status/data", "/simple930-paper/status/chart-data",
    "/simple930-paper/history", "/simple930-live", "/simple930-live/status/data",
    "/simple930-backtest", "/simple930-backtest/status", "/simple930-backtest/idle",
  ]) assert.ok(app.includes(`"${p}"`), `${p} is missing from OPEN_PATHS`);
  for (const p of ["/simple930-paper/view/", "/simple930-paper/download/"]) {
    assert.ok(app.includes(`"${p}"`), `${p} is missing from OPEN_PREFIXES`);
  }
});
check("all three routes are mounted", () => {
  const app = read("app.js");
  for (const [path, mod] of [
    ["/simple930-paper", "simple930Paper"],
    ["/simple930-backtest", "simple930Backtest"],
    ["/simple930-live", "simple930LiveHarness"],
  ]) assert.ok(new RegExp(`app\\.use\\("${path}"[\\s\\S]{0,80}${mod}`).test(app), `${path} is not mounted`);
});
check("the crash snapshot carries the LIVE trail state, not just the entry", () => {
  // Without peak/stop/trailMoves/expanded a restart would wind the stop back to
  // its initial value and re-arm an already-settled 09:45 check.
  const src = decomment(read("utils/positionPersist.js"));
  const blk = src.slice(src.indexOf("function saveSimple930Position"), src.indexOf("function loadSimple930Position"));
  for (const f of ["peak", "trough", "stop", "initialStop", "trailMoves", "expanded", "bandUp", "bandDown"]) {
    assert.ok(new RegExp(`\\b${f}:`).test(blk), `the SIMPLE_9:30 snapshot drops "${f}"`);
  }
});
check("Settings exposes every SIMPLE930_ key the code reads", () => {
  const settings = read("routes/settings.js");
  const sources = ["strategies/simple930.js", "routes/simple930Paper.js",
                   "routes/simple930Backtest.js", "routes/simple930LiveHarness.js"].map(read).join("\n");
  const keys = new Set((sources.match(/SIMPLE930_[A-Z0-9_]+/g) || [])
    .filter(k => !["SIMPLE930_PAPER", "SIMPLE930_LIVE", "SIMPLE930_BACKTEST"].includes(k)));
  const missing = [...keys].filter(k => !settings.includes(`"${k}"`));
  assert.deepStrictEqual(missing, [], `keys read by the code but absent from Settings: ${missing.join(", ")}`);
});
check("the strategy appears in the sidebar, and vanishes when disabled", () => {
  const nav = require("../src/utils/sharedNav");
  const prev = process.env.SIMPLE930_MODE_ENABLED;
  process.env.SIMPLE930_MODE_ENABLED = "true";
  const on = nav.buildSidebar("simple930Paper", false);
  assert.ok(/SIMPLE 9:30/.test(on));
  assert.ok(/\/simple930-paper\/status/.test(on));
  assert.ok(/\/simple930-backtest/.test(on));
  process.env.SIMPLE930_MODE_ENABLED = "false";
  assert.ok(!/SIMPLE 9:30/.test(nav.buildSidebar("dashboard", false)));
  if (prev === undefined) delete process.env.SIMPLE930_MODE_ENABLED; else process.env.SIMPLE930_MODE_ENABLED = prev;
});

console.log(`\n${fail ? "FAILURES" : "ALL PASS"} — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

#!/usr/bin/env node
/**
 * BN_PIVOT_RSI_ST + MULTI-INDEX INVARIANTS
 *
 *   node tests/bnPivotRsiSt.regression.js
 *
 * Zero dependencies, zero framework, exits non-zero on failure. Nothing here
 * opens a socket, a broker connection or a session.
 *
 * BN_PIVOT_RSI_ST is RSI_PIVOT_ST's rule set applied to NIFTY BANK. That claim
 * is the whole point of the strategy, and it is the thing most likely to rot:
 * two engine files drift the moment someone tunes one of them. So GROUP 1 does
 * not test the rules in the abstract — it drives BOTH engines over the SAME
 * candles and asserts they reach the SAME decision. A tuning change to either
 * side fails here until it is applied to both or deliberately declared.
 *
 * The differences that ARE legitimate are consequences of the instrument, not
 * of the strategy, and are pinned individually:
 *   - the strike grid is 100 points, not 50
 *   - the underlying is NSE:NIFTYBANK-INDEX
 *   - options are MONTHLY only (NSE withdrew BANKNIFTY weeklies in Nov-2024)
 *
 * GROUP 4 defends the shared tick feed. A BANKNIFTY strategy sharing one socket
 * with the NIFTY strategies is the highest-consequence change in this build: if
 * a BANKNIFTY tick is ever handed to a NIFTY callback, that strategy's candle
 * series is corrupted with prices ~30,000 points off, and nothing errors.
 */

const assert = require("assert");
const fs     = require("fs");
const path   = require("path");

const SRC  = path.join(__dirname, "../src");
const read = (rel) => fs.readFileSync(path.join(SRC, rel), "utf-8");

let pass = 0, fail = 0;
function section(t) { console.log(`\n${t}`); }
function check(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); pass++; }
  catch (e) { console.log(`  ❌ ${name}\n       ${e.message}`); fail++; }
}

const bn  = require("../src/strategies/bn_pivot_rsi_st");
const rsi = require("../src/strategies/rsi_pivot_st");
const instrument = require("../src/config/instrument");

// ── Fixture builder ──────────────────────────────────────────────────────────
// 5-minute bars on real IST boundaries. `base` sets the index level so the same
// shape can be replayed at NIFTY scale (~24,000) and BANKNIFTY scale (~54,000).
const DAY   = 86400;
const IST   = 19800;
// 2026-03-10 09:15 IST as a unix second, on an exact 5-minute boundary.
const T0    = Math.floor((Date.UTC(2026, 2, 10, 3, 45, 0) / 1000));

function bar(i, o, h, l, c, step = 300) {
  return { time: T0 + i * step, open: o, high: h, low: l, close: c, volume: 0 };
}

/**
 * A day that CROSSES R1 upward on the bar at `crossIdx`, with RSI driven high
 * by a long run of rising closes beforehand. Prices are absolute, so the caller
 * passes levels that match the index being simulated.
 */
function risingSeries(start, stepPts, n) {
  const out = [];
  let px = start;
  for (let i = 0; i < n; i++) {
    const o = px;
    const c = px + stepPts;
    out.push(bar(i, o, Math.max(o, c) + 1, Math.min(o, c) - 1, c));
    px = c;
  }
  return out;
}

/** Yesterday's daily bar, from which PP / R1 / S1 are derived. */
function dailyBar(h, l, c, dayOffset = -1) {
  return { time: T0 + dayOffset * DAY, open: (h + l) / 2, high: h, low: l, close: c, volume: 0 };
}

// ─────────────────────────────────────────────────────────────────────────────
section("GROUP 1 — BN_PIVOT_RSI_ST is RSI_PIVOT_ST's rules, not a variant");

check("both engines expose the identical public contract", () => {
  const skip = new Set(["NAME", "DESCRIPTION", "UNDERLYING", "strikeStep"]);
  const a = Object.keys(rsi).filter((k) => !skip.has(k)).sort();
  const b = Object.keys(bn).filter((k) => !skip.has(k)).sort();
  assert.deepStrictEqual(b, a,
    `export surfaces differ.\n  only in BN:  ${b.filter(x => !a.includes(x))}\n  only in RSI: ${a.filter(x => !b.includes(x))}`);
});

check("every config field carries the same default in both engines", () => {
  // Read with a clean env so both fall through to their coded defaults.
  const saved = {};
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("RSI_PIVOT_ST_") || k.startsWith("BN_PIVOT_RSI_ST_")) { saved[k] = process.env[k]; delete process.env[k]; }
  }
  try {
    const a = rsi.getConfig(), b = bn.getConfig();
    assert.deepStrictEqual(Object.keys(b).sort(), Object.keys(a).sort(), "config shapes differ");
    for (const k of Object.keys(a)) {
      assert.deepStrictEqual(b[k], a[k],
        `default for "${k}" differs: BN=${JSON.stringify(b[k])} vs RSI_PIVOT_ST=${JSON.stringify(a[k])}. ` +
        `BN_PIVOT_RSI_ST is the same rules on another index — a threshold may only differ deliberately.`);
    }
  } finally { Object.assign(process.env, saved); }
});

check("the two engines reach the SAME decision on the same candles", () => {
  // Same shape, same levels — only the engine differs. Any divergence here is a
  // rule divergence, which is exactly what must not exist.
  const candles = risingSeries(54000, 40, 40);
  const daily   = [dailyBar(54200, 53600, 54000)];
  const opts    = { dailyCandles: daily, silent: true };
  for (let n = 20; n <= candles.length; n++) {
    const slice = candles.slice(0, n);
    const a = rsi.getSignal(slice, { ...opts, cfg: rsi.getConfig() });
    const b = bn.getSignal(slice,  { ...opts, cfg: bn.getConfig()  });
    assert.strictEqual(b.signal, a.signal, `signal differs at bar ${n}: BN=${b.signal} RSI=${a.signal}`);
    assert.strictEqual(b.side || null, a.side || null, `side differs at bar ${n}`);
    if (a.signal && b.signal) {
      assert.strictEqual(b.entrySpot, a.entrySpot, `entry differs at bar ${n}`);
      assert.strictEqual(b.slSpot ?? null, a.slSpot ?? null, `stop differs at bar ${n}`);
    }
  }
});

check("the engines compute identical pivots from the same daily bar", () => {
  const daily = [dailyBar(54200, 53600, 54000)];
  const a = rsi.computePivots(daily, {});
  const b = bn.computePivots(daily, {});
  assert.deepStrictEqual({ pp: b.pp, r1: b.r1, s1: b.s1 }, { pp: a.pp, r1: a.r1, s1: a.s1 });
});

check("the engines compute identical RSI and SuperTrend series", () => {
  const candles = risingSeries(54000, 40, 40);
  assert.deepStrictEqual(bn.computeRsi(candles, 14), rsi.computeRsi(candles, 14));
  assert.deepStrictEqual(
    bn.computeSuperTrendSeries(candles, bn.getConfig()),
    rsi.computeSuperTrendSeries(candles, rsi.getConfig())
  );
});

// ─────────────────────────────────────────────────────────────────────────────
section("GROUP 2 — the instrument differences, and ONLY those");

check("BN identifies itself as the BANKNIFTY strategy", () => {
  assert.strictEqual(bn.NAME, "BN_PIVOT_RSI_ST");
  assert.strictEqual(bn.UNDERLYING, "BANKNIFTY");
  assert.strictEqual(rsi.NAME, "RSI_PIVOT_ST");
});

check("BN strikes land on the 100-point BANKNIFTY grid, NIFTY's on 50", () => {
  const cfg = { ...bn.getConfig(), strikeMode: "ATM", strikePct: 0 };
  for (const spot of [54387, 54412, 53950.5, 55000]) {
    const s = bn.strikeForSide(spot, "CE", cfg).strike;
    assert.strictEqual(s % 100, 0, `BANKNIFTY strike ${s} is not on the 100-point grid`);
  }
  const rc = { ...rsi.getConfig(), strikeMode: "ATM", strikePct: 0 };
  assert.strictEqual(rsi.strikeForSide(24374, "CE", rc).strike % 50, 0);
});

check("the 1% OTM rule shifts the right way on both sides", () => {
  const cfg = { ...bn.getConfig(), strikeMode: "OTM", strikePct: 1 };
  const ce = bn.strikeForSide(54387, "CE", cfg);
  const pe = bn.strikeForSide(54387, "PE", cfg);
  assert.ok(ce.strike > 54387, `OTM CE must sit above spot, got ${ce.strike}`);
  assert.ok(pe.strike < 54387, `OTM PE must sit below spot, got ${pe.strike}`);
  assert.strictEqual(ce.steps, 5, "1% of ~54,000 is ~540pts = 5 strikes of 100");
  assert.strictEqual(pe.steps, 5);
});

check("ITM is the exact mirror of OTM", () => {
  const otm = { ...bn.getConfig(), strikeMode: "OTM", strikePct: 1 };
  const itm = { ...bn.getConfig(), strikeMode: "ITM", strikePct: 1 };
  const atm = bn.strikeForSide(54400, "CE", { ...otm, strikeMode: "ATM" }).strike;
  const o = bn.strikeForSide(54400, "CE", otm).strike;
  const i = bn.strikeForSide(54400, "CE", itm).strike;
  assert.strictEqual(o - atm, atm - i, "ITM and OTM must be equidistant from ATM");
});

check("the strike grid is Settings-configurable, not hard-coded", () => {
  const prev = process.env.BANKNIFTY_STRIKE_STEP;
  try {
    process.env.BANKNIFTY_STRIKE_STEP = "500";
    assert.strictEqual(bn.strikeStep(), 500, "BANKNIFTY_STRIKE_STEP must be read live");
    const s = bn.strikeForSide(54387, "CE", { ...bn.getConfig(), strikeMode: "ATM", strikePct: 0 }).strike;
    assert.strictEqual(s % 500, 0, `strike ${s} ignored the configured grid`);
  } finally {
    if (prev === undefined) delete process.env.BANKNIFTY_STRIKE_STEP; else process.env.BANKNIFTY_STRIKE_STEP = prev;
  }
});

check("a degenerate percentage falls back to ATM rather than inventing a strike", () => {
  const cfg = { ...bn.getConfig(), strikeMode: "OTM", strikePct: 0.0001 };
  const r = bn.strikeForSide(54387, "CE", cfg);
  assert.strictEqual(r.mode, "ATM");
  assert.strictEqual(r.steps, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
section("GROUP 3 — the two strategies are configured INDEPENDENTLY");

check("BN reads BN_PIVOT_RSI_ST_* and never RSI_PIVOT_ST_*", () => {
  const a = process.env.RSI_PIVOT_ST_RSI_CE_MIN;
  const b = process.env.BN_PIVOT_RSI_ST_RSI_CE_MIN;
  try {
    process.env.RSI_PIVOT_ST_RSI_CE_MIN = "88";
    delete process.env.BN_PIVOT_RSI_ST_RSI_CE_MIN;
    assert.strictEqual(rsi.getConfig().rsiCeMin, 88, "RSI_PIVOT_ST must honour its own key");
    assert.strictEqual(bn.getConfig().rsiCeMin, 70, "BN must NOT inherit RSI_PIVOT_ST's key");

    process.env.BN_PIVOT_RSI_ST_RSI_CE_MIN = "62";
    assert.strictEqual(bn.getConfig().rsiCeMin, 62, "BN must honour its own key");
    assert.strictEqual(rsi.getConfig().rsiCeMin, 88, "RSI_PIVOT_ST must not be moved by BN's key");
  } finally {
    if (a === undefined) delete process.env.RSI_PIVOT_ST_RSI_CE_MIN; else process.env.RSI_PIVOT_ST_RSI_CE_MIN = a;
    if (b === undefined) delete process.env.BN_PIVOT_RSI_ST_RSI_CE_MIN; else process.env.BN_PIVOT_RSI_ST_RSI_CE_MIN = b;
  }
});

check("the engine source contains no leftover RSI_PIVOT_ST_ env key", () => {
  const src = read("strategies/bn_pivot_rsi_st.js");
  const code = src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  assert.ok(!/\bRSI_PIVOT_ST_/.test(code),
    "a rename left an RSI_PIVOT_ST_* key in bn_pivot_rsi_st.js — the two strategies would share a setting");
});

// ─────────────────────────────────────────────────────────────────────────────
section("GROUP 4 — the underlying registry and the BANKNIFTY contract");

check("NIFTY keeps its original, unprefixed Settings keys", () => {
  const u = instrument.UNDERLYING_DEFS.NIFTY.env;
  assert.strictEqual(u.offsetCE, "STRIKE_OFFSET_CE", "renaming this resets every existing .env to defaults");
  assert.strictEqual(u.expiryOverride, "OPTION_EXPIRY_OVERRIDE");
  assert.strictEqual(u.lotSize, "NIFTY_LOT_SIZE");
});

check("BANKNIFTY has its OWN key for every configurable field", () => {
  const n = instrument.UNDERLYING_DEFS.NIFTY.env;
  const b = instrument.UNDERLYING_DEFS.BANKNIFTY.env;
  assert.deepStrictEqual(Object.keys(b).sort(), Object.keys(n).sort(), "the two index key sets must be symmetric");
  for (const k of Object.keys(b)) {
    assert.notStrictEqual(b[k], n[k], `BANKNIFTY shares the "${k}" key with NIFTY — one index would move the other`);
    assert.ok(/^BANKNIFTY_/.test(b[k]), `BANKNIFTY key for "${k}" is "${b[k]}" — expected a BANKNIFTY_ prefix`);
  }
});

check("BANKNIFTY is monthly-only and NIFTY is not", () => {
  assert.strictEqual(instrument.underlyingOf("BANKNIFTY").weekly, false,
    "NSE withdrew BANKNIFTY weekly options in Nov-2024");
  assert.strictEqual(instrument.underlyingOf("NIFTY").weekly, true);
});

check("a monthly-only index never produces a weekly expiry code", () => {
  // 10-Mar-2026 is a Tuesday in the MIDDLE of the month — a weekly date for NIFTY.
  const midMonthTuesday = new Date(2026, 2, 10);
  assert.strictEqual(instrument.expiryCodeFor(midMonthTuesday, "NIFTY"), "26310",
    "NIFTY must still use the weekly YYMDD code");
  assert.strictEqual(instrument.expiryCodeFor(midMonthTuesday, "BANKNIFTY"), "26MAR",
    "a weekly code for BANKNIFTY names a contract NSE does not list");
});

check("omitting the underlying means NIFTY — every legacy call site is unchanged", () => {
  const d = new Date(2026, 2, 10);
  assert.strictEqual(instrument.expiryCodeFor(d), instrument.expiryCodeFor(d, "NIFTY"));
  assert.strictEqual(instrument.calcATMStrike(24387), 24400);
  assert.strictEqual(instrument.underlyingOf().key, "NIFTY");
  assert.strictEqual(instrument.underlyingOf("nonsense-index").key, "NIFTY",
    "an unknown underlying must fall back to NIFTY, never throw mid-session");
});

check("the strike grid and lot size are per-index and read live", () => {
  const prevB = process.env.BANKNIFTY_LOT_SIZE, prevN = process.env.NIFTY_LOT_SIZE;
  try {
    process.env.BANKNIFTY_LOT_SIZE = "35";
    process.env.NIFTY_LOT_SIZE     = "75";
    assert.strictEqual(instrument.underlyingOf("BANKNIFTY").lotSize, 35);
    assert.strictEqual(instrument.underlyingOf("NIFTY").lotSize, 75, "one index's lot must not move the other's");
  } finally {
    if (prevB === undefined) delete process.env.BANKNIFTY_LOT_SIZE; else process.env.BANKNIFTY_LOT_SIZE = prevB;
    if (prevN === undefined) delete process.env.NIFTY_LOT_SIZE; else process.env.NIFTY_LOT_SIZE = prevN;
  }
});

check("a garbage per-index value falls back to the default, never to 0 or NaN", () => {
  const prev = process.env.BANKNIFTY_LOT_SIZE;
  try {
    for (const bad of ["", "abc", "0", "-5"]) {
      process.env.BANKNIFTY_LOT_SIZE = bad;
      const n = instrument.underlyingOf("BANKNIFTY").lotSize;
      assert.ok(Number.isFinite(n) && n > 0, `BANKNIFTY_LOT_SIZE="${bad}" produced ${n} — a zero lot size sizes every order at 0`);
    }
  } finally { if (prev === undefined) delete process.env.BANKNIFTY_LOT_SIZE; else process.env.BANKNIFTY_LOT_SIZE = prev; }
});

// ─────────────────────────────────────────────────────────────────────────────
section("GROUP 5 — the shared socket must never cross the two indices");

const socketManager = require("../src/utils/socketManager");

check("socketManager exposes the multi-index API", () => {
  for (const fn of ["addSpotSymbol", "removeSpotSymbol", "spotSymbols"]) {
    assert.strictEqual(typeof socketManager[fn], "function", `socketManager.${fn}() is missing`);
  }
});

check("a callback bound to one index never receives the other's ticks", () => {
  const NIFTY = "NSE:NIFTY50-INDEX", BANK = "NSE:NIFTYBANK-INDEX";
  const sm = socketManager;
  // Drive _routeTick directly — no wire, no SDK, no connection.
  const saved = {
    symbol: sm._symbol, spots: sm._spotSymbols, handlers: sm._spotHandlers,
    cbs: sm._callbacks, onSpot: sm._onSpotTick, stopped: sm._stopped,
    probe: sm._spotTickSymbol, extras: sm._extraSymbols,
  };
  try {
    sm._symbol        = NIFTY;
    sm._spotSymbols   = new Set([NIFTY, BANK]);
    sm._spotHandlers  = new Map();
    sm._callbacks     = new Map();
    sm._extraSymbols  = new Set();
    sm._spotTickSymbol = NIFTY;
    sm._stopped       = false;

    const got = { nifty: [], bank: [], unbound: [] };
    sm._onSpotTick = (t) => got.nifty.push(t.ltp);           // primary = NIFTY
    sm.addCallback("bank-strategy", (t) => got.bank.push(t.ltp), null, BANK);
    sm.addCallback("legacy-nifty",  (t) => got.unbound.push(t.ltp), null);   // no symbol → primary

    sm._routeTick({ symbol: NIFTY, ltp: 24400 });
    sm._routeTick({ symbol: BANK,  ltp: 54400 });

    assert.deepStrictEqual(got.nifty, [24400], "the NIFTY primary saw a wrong or missing tick");
    assert.deepStrictEqual(got.bank,  [54400], "the BANKNIFTY callback saw a wrong or missing tick");
    assert.deepStrictEqual(got.unbound, [24400],
      "a callback registered WITHOUT a symbol must default to the primary index — it received a BANKNIFTY price");
  } finally {
    sm._symbol = saved.symbol; sm._spotSymbols = saved.spots; sm._spotHandlers = saved.handlers;
    sm._callbacks = saved.cbs; sm._onSpotTick = saved.onSpot; sm._stopped = saved.stopped;
    sm._spotTickSymbol = saved.probe; sm._extraSymbols = saved.extras;
  }
});

check("a callback registered BEFORE start() still binds to the primary index", () => {
  // The option-chain recorder registers at boot, before any strategy calls
  // start(), so `this._symbol` is still null at registration. Freezing null as
  // its bound index and then treating null as "deliver everything" handed it
  // BOTH indices' ticks the moment a second one joined.
  const NIFTY = "NSE:NIFTY50-INDEX", BANK = "NSE:NIFTYBANK-INDEX";
  const sm = socketManager;
  const saved = {
    symbol: sm._symbol, spots: sm._spotSymbols, handlers: sm._spotHandlers,
    cbs: sm._callbacks, onSpot: sm._onSpotTick, stopped: sm._stopped,
    probe: sm._spotTickSymbol, extras: sm._extraSymbols,
  };
  try {
    // Registered while the socket has NO primary yet.
    sm._symbol = null; sm._callbacks = new Map(); sm._spotHandlers = new Map();
    const seen = [];
    sm.addCallback("registered-at-boot", (t) => seen.push(t.ltp), null);

    // A strategy starts on NIFTY; a BANKNIFTY strategy joins later.
    sm._symbol = NIFTY;
    sm._spotSymbols = new Set([NIFTY, BANK]);
    sm._extraSymbols = new Set();
    sm._spotTickSymbol = NIFTY;
    sm._onSpotTick = null;
    sm._stopped = false;

    sm._routeTick({ symbol: NIFTY, ltp: 24400 });
    sm._routeTick({ symbol: BANK,  ltp: 54400 });

    assert.deepStrictEqual(seen, [24400],
      "a boot-time callback received a BANKNIFTY tick — it must resolve to the primary index at DELIVERY time, not freeze null at registration");
  } finally {
    sm._symbol = saved.symbol; sm._spotSymbols = saved.spots; sm._spotHandlers = saved.handlers;
    sm._callbacks = saved.cbs; sm._onSpotTick = saved.onSpot; sm._stopped = saved.stopped;
    sm._spotTickSymbol = saved.probe; sm._extraSymbols = saved.extras;
  }
});

check("an unattributable tick is DROPPED, never delivered as a guess", () => {
  const NIFTY = "NSE:NIFTY50-INDEX", BANK = "NSE:NIFTYBANK-INDEX";
  const sm = socketManager;
  const saved = {
    symbol: sm._symbol, spots: sm._spotSymbols, handlers: sm._spotHandlers,
    cbs: sm._callbacks, onSpot: sm._onSpotTick, stopped: sm._stopped,
    probe: sm._spotTickSymbol, extras: sm._extraSymbols, streak: sm._unattributedStreak,
  };
  try {
    sm._symbol = NIFTY;
    sm._spotSymbols = new Set([NIFTY, BANK]);
    sm._spotHandlers = new Map(); sm._callbacks = new Map(); sm._extraSymbols = new Set();
    sm._spotTickSymbol = NIFTY; sm._stopped = false; sm._unattributedStreak = 0;

    let delivered = 0;
    sm._onSpotTick = () => { delivered++; };
    sm.addCallback("bank", () => { delivered++; }, null, BANK);

    sm._routeTick({ symbol: "NSE:SOMETHING-ELSE", ltp: 999 });
    assert.strictEqual(delivered, 0,
      "an unattributable tick reached a strategy — with two indices up, a guess writes the wrong index's price into a candle series");
  } finally {
    sm._symbol = saved.symbol; sm._spotSymbols = saved.spots; sm._spotHandlers = saved.handlers;
    sm._callbacks = saved.cbs; sm._onSpotTick = saved.onSpot; sm._stopped = saved.stopped;
    sm._spotTickSymbol = saved.probe; sm._extraSymbols = saved.extras; sm._unattributedStreak = saved.streak;
  }
});

check("start() on a running socket ADDS an index instead of re-pointing it", () => {
  const src = read("utils/socketManager.js");
  assert.ok(/addSpotSymbol\(spotSymbol, onSpotTick, onLog\)/.test(src),
    "start() must delegate a second index to addSpotSymbol — re-pointing cuts the feed out from under every running strategy");
});

check("the recorder labels each spot tick with its index", () => {
  const src = read("utils/tickRecorder.js");
  assert.ok(/function recordSpotTick\(tick, spotSymbol\)/.test(src),
    "recordSpotTick must accept the index, or one day file mixes NIFTY and BANKNIFTY ticks with no way to separate them on replay");
  assert.ok(/rec\.idx = spotSymbol/.test(src), "the index must be written onto the record as `idx`");
});

// ─────────────────────────────────────────────────────────────────────────────
section("GROUP 6 — refusals and guards");

check("the engine refuses rather than guessing when history is short", () => {
  const need = bn.minBarsFor(bn.getConfig());
  const r = bn.getSignal(risingSeries(54000, 40, 3), { dailyCandles: [dailyBar(54200, 53600, 54000)], silent: true });
  assert.strictEqual(r.signal, "NONE", "a signal on 3 bars means the RSI was quoted from nothing");
  assert.strictEqual(r.warmup, true, "a warm-up refusal must SAY it is one, not fail silently");
  assert.ok(/Warming up \(3\/\d+/.test(r.skipReason || ""),
    `the refusal must name how many bars it still needs, got: ${r.skipReason}`);
  assert.ok(need > 3, "minBarsFor must exceed the fixture, or this test proves nothing");
});

check("the warm-up threshold covers BOTH indicators, not just the longer one", () => {
  const cfg = bn.getConfig();
  const need = bn.minBarsFor(cfg);
  assert.ok(need > cfg.rsiPeriod, `minBars ${need} does not clear RSI(${cfg.rsiPeriod})`);
  assert.ok(need > cfg.stPeriod,  `minBars ${need} does not clear SuperTrend(${cfg.stPeriod})`);
});

check("no pivots without a previous daily bar", () => {
  const r = bn.computePivots([], {});
  assert.ok(!r || r.r1 == null || r.pp == null,
    "pivots computed from no daily bar would place R1/S1 at an invented level");
});

check("null / NaN prices never become a decision", () => {
  // Past warm-up, so the OHLC guard is what has to catch these — a short series
  // would be refused for warm-up instead and prove nothing.
  const daily = [dailyBar(54200, 53600, 54000)];
  const good  = risingSeries(54000, 40, 40);
  for (const poison of [null, NaN, "", undefined]) {
    for (const field of ["open", "high", "low", "close"]) {
      const s = good.map((c) => ({ ...c }));
      s[s.length - 1][field] = poison;
      const r = bn.getSignal(s, { dailyCandles: daily, silent: true });
      assert.strictEqual(r.signal, "NONE",
        `${field}=${JSON.stringify(poison)} produced a signal — Number(null)===0 and Number('')===0 both invent a price`);
      assert.ok(typeof r.skipReason === "string" && r.skipReason.length,
        `${field}=${JSON.stringify(poison)} was refused SILENTLY — a refusal with no reason cannot be diagnosed from /logs`);
    }
  }
});

check("a daily series handed to the intraday engine is refused, not computed", () => {
  const daily = [dailyBar(54200, 53600, 54000)];
  const oneBarPerDay = [];
  for (let i = 0; i < 40; i++) {
    oneBarPerDay.push(bar(i, 54000 + i * 40, 54100 + i * 40, 53900 + i * 40, 54050 + i * 40, DAY));
  }
  const r = bn.getSignal(oneBarPerDay, { dailyCandles: daily, silent: true });
  assert.strictEqual(r.signal, "NONE", "a 5-minute RSI computed over daily bars is not the strategy's rule");
  assert.ok(/not intraday candles|one bar per day/i.test(r.skipReason || ""),
    `the refusal must say WHY, got: ${r.skipReason}`);
});

check("strikeForSide refuses a nonsense spot instead of naming a strike", () => {
  for (const bad of [null, undefined, NaN, 0, -1, "54000"]) {
    assert.strictEqual(bn.strikeForSide(bad, "CE", bn.getConfig()), null, `spot=${JSON.stringify(bad)} produced a strike`);
  }
  assert.strictEqual(bn.strikeForSide(54000, "XX", bn.getConfig()), null, "an invalid side produced a strike");
});

// ─────────────────────────────────────────────────────────────────────────────
console.log(fail === 0
  ? `\nALL PASS — ${pass} passed, 0 failed`
  : `\nFAILURES — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

/**
 * pairRuntime.regression.js — the market-generic runtime every converted paper
 * route (create(pair) builder) reads its per-market facts from.
 * ─────────────────────────────────────────────────────────────────────────────
 *   • identity: NIFTY's home pair is exactly the registry's keys / paths / files;
 *     BN / FUT pairs keep the old twins' paths and data files
 *   • symbols, strike grid, lot, expiry day per market (NSE weekly, BSE Thursday
 *     weekly, BANKNIFTY monthly-only, NIFTY futures, holiday prepone)
 *   • paper fills at the quote (non-NIFTY default ON, NIFTY never)
 *   • per-pair bid-ask spread limit with NIFTY's fallback
 *   • <PAIR>_EXPIRY_DAY_ONLY inherits NIFTY's value
 *   • pair inheritance of strategy keys (envGet), generic socket slots, pair
 *     crash snapshots, pair log files, market tags, marketOnly lifted while a
 *     running pair is on
 *
 *   node tests/pairRuntime.regression.js
 */

"use strict";

const assert = require("assert");
const fs     = require("fs");
const os     = require("os");
const path   = require("path");

// Sandbox HOME before anything resolves ~/trading-data.
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "pair-runtime-"));
process.env.HOME = SANDBOX;
process.chdir(SANDBOX);
for (const k of Object.keys(process.env)) {
  if (/(_MODE_ENABLED|_EXPIRY_DAY_ONLY|_PAPER_FILL_AT_QUOTE|_MAX_SPREAD_PTS|_OPTION_EXPIRY_OVERRIDE|_OPTION_EXPIRY_TYPE)$|^(MAX_BID_ASK_SPREAD_PTS|LOT_MULTIPLIER|EMA_RSI_ST_V2_)/.test(k)) delete process.env[k];
}

let pass = 0, fail = 0;
function section(t) { _queue.push([{ title: t }, null]); }
// Checks run in order; one that returns a promise is awaited before the next.
const _queue = [];
function check(name, fn) { _queue.push([name, fn]); }
async function _runChecks() {
  for (const [name, fn] of _queue) {
    if (typeof name === "object") { console.log(`\n${name.title}`); continue; }
    try { await fn(); console.log(`  ✅ ${name}`); pass++; }
    catch (e) { console.log(`  ❌ ${name}\n       ${e.message}`); fail++; }
  }
}
function withEnv(vars, fn) {
  const prev = {};
  for (const [k, v] of Object.entries(vars)) { prev[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return fn(); }
  finally { for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}
const IST = 19800000;
const istMs = (ymd, hh = 10, mm = 0) => Date.parse(`${ymd}T00:00:00Z`) - IST + (hh * 60 + mm) * 60000;

const pairs       = require("../src/config/pairs");
const pairRuntime = require("../src/utils/pairRuntime");
const instrument  = require("../src/config/instrument");
const tradeGuards = require("../src/utils/tradeGuards");
const rtOf = (mk) => pairRuntime.forStrategy("emaRsiStV2", mk);

// ─────────────────────────────────────────────────────────────────────────────
section("Identity");

check("NIFTY is the home pair: registry keys, path, file, slot, sidebar", () => {
  const rt = rtOf("NIFTY");
  assert.deepStrictEqual(
    [rt.home, rt.isNiftyHome, rt.modeKey, rt.envPrefix, rt.paperPath, rt.replayMode, rt.tradesFile, rt.socketSlot.mode, rt.notifyMode, rt.sidebarKey, rt.historySidebarKey],
    [true, true, "ema_rsi_st_v2", "EMA_RSI_ST_V2", "/ema_rsi_st_v2-paper", "ema_rsi_st_v2-paper", "ema_rsi_st_v2_paper_trades.json", "EMA_RSI_ST_V2_PAPER", "EMA_RSI_ST_V2-PAPER", "emaRsiStV2Paper", "emaRsiStV2History"]);
  assert.strictEqual(rt.spotLabel, "NIFTY");
  assert.strictEqual(rt.oiApplies, true);
});
check("BANKNIFTY / NIFTY_FUT keep the old twins' paths and data files", () => {
  const bn = rtOf("BANKNIFTY"), fut = rtOf("NIFTY_FUT");
  assert.deepStrictEqual([bn.paperPath, bn.tradesFile, bn.modeKey, bn.socketSlot.mode], ["/bn_ema_rsi_st_v2-paper", "bn_ema_rsi_st_v2_paper_trades.json", "bn_ema_rsi_st_v2", "BN_EMA_RSI_ST_V2_PAPER"]);
  assert.deepStrictEqual([fut.paperPath, fut.tradesFile, fut.modeKey], ["/fut_ema_rsi_st_v2-paper", "fut_ema_rsi_st_v2_paper_trades.json", "fut_ema_rsi_st_v2"]);
  assert.strictEqual(rtOf("SENSEX").paperPath, "/sensex_ema_rsi_st_v2-paper");
});
check("running pairs = every offered non-home V2 / BB_RSI pair; none other runs", () => {
  const all7 = ["NIFTY_FUT", "BANKNIFTY", "SENSEX", "CRUDE", "GOLD", "SILVER", "SAIL"];
  assert.deepStrictEqual(pairs.runnable().filter(p => p.strategyId === "emaRsiStV2").map(p => p.marketKey), all7);
  assert.deepStrictEqual(pairs.runnable().filter(p => p.strategyId === "bbRsi").map(p => p.marketKey), all7);
  assert.ok(pairs.all().filter(p => p.runs).every(p => p.strategyId === "emaRsiStV2" || p.strategyId === "bbRsi"));
  assert.strictEqual(pairs.byReplayMode("bn_ema_rsi_st_v2-paper").marketKey, "BANKNIFTY");
  assert.strictEqual(pairs.byReplayMode("ema_rsi_st_v2-paper"), null, "the home mode is the registry's");
});
check("every pair ships OFF", () => {
  for (const p of pairs.runnable()) assert.strictEqual(pairRuntime.forPair(p).enabled(), false, p.id);
});

// ─────────────────────────────────────────────────────────────────────────────
section("Market facts");

check("spot, grid, lot, instrument per market", () => {
  const rows = ["NIFTY", "BANKNIFTY", "SENSEX", "NIFTY_FUT", "SAIL"].map(mk => {
    const r = rtOf(mk);
    return [mk, r.spotSymbol(), r.strikeStep(), r.lotQty(), r.instrumentName(), r.kind];
  });
  assert.deepStrictEqual(rows, [
    ["NIFTY", "NSE:NIFTY50-INDEX", 50, 65, instrument.INSTRUMENT, "options"],
    ["BANKNIFTY", "NSE:NIFTYBANK-INDEX", 100, 30, "BANKNIFTY_OPTIONS", "options"],
    ["SENSEX", "BSE:SENSEX-INDEX", 100, 20, "SENSEX_OPTIONS", "options"],
    ["NIFTY_FUT", "NSE:NIFTY50-INDEX", null, 65, "NIFTY_FUTURES", "futures"],
    ["SAIL", "NSE:SAIL-EQ", 2.5, 4700, "SAIL_OPTIONS", "options"],
  ]);
});
check("LOT_MULTIPLIER (clamped) applies to every market", () => withEnv({ LOT_MULTIPLIER: "2" }, () => {
  assert.deepStrictEqual(["NIFTY", "BANKNIFTY", "SENSEX", "NIFTY_FUT"].map(mk => rtOf(mk).lotQty()), [130, 60, 40, 130]);
}));
check("ATM grid and the pre-fetch tolerance (NIFTY 50 / 25 as before)", () => {
  assert.deepStrictEqual([rtOf("NIFTY").atmOf(24537), rtOf("NIFTY").cacheTolerance()], [24550, 25]);
  assert.deepStrictEqual([rtOf("BANKNIFTY").atmOf(57849), rtOf("BANKNIFTY").cacheTolerance()], [57800, 50]);
  assert.deepStrictEqual([rtOf("SENSEX").atmOf(80051), rtOf("SAIL").atmOf(168.9)], [80100, 170]);
});
check("option symbols parse per exchange / cadence", () => {
  assert.deepStrictEqual(rtOf("SENSEX").parseOptionSymbol("BSE:SENSEX26N1269200CE"), { expiry: "12 NOV 2026", expiryRaw: "26N12", strike: 69200, optionType: "CE" });
  assert.deepStrictEqual(rtOf("SENSEX").parseOptionSymbol("BSE:SENSEX26NOV64600PE"), { expiry: "NOV 2026", expiryRaw: "26NOV", strike: 64600, optionType: "PE" });
  assert.strictEqual(rtOf("SENSEX").parseOptionSymbol("NSE:SENSEX26N1269200CE"), null, "wrong exchange");
  assert.deepStrictEqual(rtOf("BANKNIFTY").parseOptionSymbol("NSE:BANKNIFTY26NOV57800CE"), { expiry: "NOV 2026", expiryRaw: "26NOV", strike: 57800, optionType: "CE" });
  assert.deepStrictEqual(rtOf("SAIL").parseOptionSymbol("NSE:SAIL26NOV167.5CE"), { expiry: "NOV 2026", expiryRaw: "26NOV", strike: 167.5, optionType: "CE" });
  assert.strictEqual(rtOf("NIFTY_FUT").parseOptionSymbol("NSE:NIFTY26NOVFUT"), null, "futures have no option parts");
});
check("the order builders spell the row's exchange (BSE:SENSEX…)", () => withEnv({ SENSEX_OPTION_EXPIRY_OVERRIDE: "2099-01-01", SENSEX_OPTION_EXPIRY_TYPE: "monthly" }, () => {
  assert.strictEqual(instrument.getSymbolSync("CE", "SENSEX").slice(0, 10), "BSE:SENSEX");
  return instrument.validateAndGetOptionSymbol(80051, "CE", "sensex_ema_rsi_st_v2", { underlying: "SENSEX" }).then(r => {
    assert.strictEqual(r.symbol, "BSE:SENSEX99JAN80100CE");
  });
}));
check("NIFTY futures symbol is the month contract on NSE", () => {
  assert.ok(/^NSE:NIFTY\d{2}[A-Z]{3}FUT$/.test(instrument.getSymbolSync("CE", "NIFTY", "NIFTY_FUTURES")));
});

check("expiry day: SENSEX Thursday weekly, NIFTY Tuesday, BANKNIFTY monthly, holiday preponed", () => {
  const S = rtOf("SENSEX"), B = rtOf("BANKNIFTY"), F = rtOf("NIFTY_FUT");
  assert.deepStrictEqual([S.isExpiryDay(istMs("2026-11-12")), S.isExpiryDay(istMs("2026-11-17"))], [true, false]);
  // Nov-2026: last Tuesday 24-Nov is an NSE holiday → BANKNIFTY monthly + NIFTY futures expire Monday 23-Nov.
  assert.deepStrictEqual([B.isExpiryDay(istMs("2026-11-23")), B.isExpiryDay(istMs("2026-11-24")), B.isExpiryDay(istMs("2026-11-17"))], [true, false, false]);
  assert.deepStrictEqual([F.isExpiryDay(istMs("2026-11-23")), F.isExpiryDay(istMs("2026-11-17"))], [true, false]);
  // 26-Nov-2026 is SENSEX's monthly (last Thursday).
  assert.strictEqual(S.isExpiryDay(istMs("2026-11-26")), true);
});
check("session hours: NSE/BSE from TRADE_*_TIME, MCX its own", () => withEnv({ TRADE_STOP_TIME: "15:20" }, () => {
  assert.deepStrictEqual([rtOf("SENSEX").sessionOpenMin(), rtOf("SENSEX").stopMins()], [555, 920]);
  assert.deepStrictEqual([rtOf("CRUDE").sessionOpenMin(), rtOf("CRUDE").stopMins()], [540, 1410]);
}));

// ─────────────────────────────────────────────────────────────────────────────
section("Fills and guards");

const Q = { bid: 100, ask: 101.5, ltp: 100.8, at: 1_000_000 };
check("quoteFill: ask on entry / bid on exit of a fresh quote, else the LTP", () => {
  const f = pairRuntime.quoteFill;
  assert.deepStrictEqual(f("buy", 100.8, Q, { enabled: true, nowMs: 1_005_000 }), { price: 101.5, source: "ask" });
  assert.deepStrictEqual(f("sell", 100.8, Q, { enabled: true, nowMs: 1_005_000 }), { price: 100, source: "bid" });
  assert.deepStrictEqual(f("sell", 100.8, Q, { enabled: true, nowMs: 1_000_000 + 16_000, freshMs: 15_000 }), { price: 100.8, source: "ltp" }, "stale quote");
  assert.deepStrictEqual(f("buy", 100.8, Q, { enabled: false, nowMs: 1_005_000 }), { price: 100.8, source: "ltp" });
  assert.deepStrictEqual(f("buy", 100.8, { ...Q, ask: 0 }, { enabled: true, nowMs: 1_005_000 }), { price: 100.8, source: "ltp" });
});
check("<PAIR>_PAPER_FILL_AT_QUOTE: default ON off NIFTY, OFF when set false; NIFTY never", () => {
  assert.strictEqual(rtOf("SENSEX").fillAtQuote(), true);
  assert.strictEqual(rtOf("SENSEX").fillAtQuoteKey, "SENSEX_EMA_RSI_ST_V2_PAPER_FILL_AT_QUOTE");
  withEnv({ SENSEX_EMA_RSI_ST_V2_PAPER_FILL_AT_QUOTE: "false" }, () => assert.strictEqual(rtOf("SENSEX").fillAtQuote(), false));
  withEnv({ EMA_RSI_ST_V2_PAPER_FILL_AT_QUOTE: "true" }, () => assert.strictEqual(rtOf("NIFTY").fillAtQuote(), false));
  assert.strictEqual(rtOf("NIFTY").fillAtQuoteKey, null);
  assert.deepStrictEqual(rtOf("BANKNIFTY").entryFill(57, { ...Q, at: Date.now() }), { price: 101.5, source: "ask" });
  assert.deepStrictEqual(rtOf("NIFTY").entryFill(57, { ...Q, at: Date.now() }), { price: 57, source: "ltp" });
});
check("spread limit: <PAIR>_MAX_SPREAD_PTS → MAX_BID_ASK_SPREAD_PTS → 2; NIFTY = the guard's own default", () => {
  assert.strictEqual(rtOf("NIFTY").maxSpreadPts(), undefined);
  assert.strictEqual(rtOf("SENSEX").maxSpreadPts(), 2);
  withEnv({ MAX_BID_ASK_SPREAD_PTS: "3" }, () => {
    assert.strictEqual(rtOf("SENSEX").maxSpreadPts(), 3);
    withEnv({ SENSEX_EMA_RSI_ST_V2_MAX_SPREAD_PTS: "8" }, () => {
      assert.strictEqual(rtOf("SENSEX").maxSpreadPts(), 8);
      assert.strictEqual(tradeGuards.checkSpread(100, 106, rtOf("SENSEX").maxSpreadPts()).ok, true);
      assert.strictEqual(tradeGuards.checkSpread(100, 106, rtOf("NIFTY").maxSpreadPts()).ok, false, "NIFTY keeps 3");
    });
  });
});
check("<PAIR>_EXPIRY_DAY_ONLY: own value, else NIFTY's EMA_RSI_ST_V2_EXPIRY_DAY_ONLY, else every day", () => {
  assert.strictEqual(rtOf("SENSEX").expiryDayOnly(), false);
  withEnv({ EMA_RSI_ST_V2_EXPIRY_DAY_ONLY: "true" }, () => {
    assert.strictEqual(rtOf("SENSEX").expiryDayOnly(), true, "inherits NIFTY");
    withEnv({ SENSEX_EMA_RSI_ST_V2_EXPIRY_DAY_ONLY: "false" }, () => assert.strictEqual(rtOf("SENSEX").expiryDayOnly(), false, "own wins"));
  });
});
check("paper switch: the pair's own value, else NIFTY's EMA_RSI_ST_V2_PAPER_ENABLED", () => {
  assert.strictEqual(rtOf("BANKNIFTY").paperEnabled(), false);
  withEnv({ EMA_RSI_ST_V2_PAPER_ENABLED: "true" }, () => {
    assert.strictEqual(rtOf("BANKNIFTY").paperEnabled(), true);
    withEnv({ BN_EMA_RSI_ST_V2_PAPER_ENABLED: "false" }, () => assert.strictEqual(rtOf("BANKNIFTY").paperEnabled(), false));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
section("Shared slots and files");

check("envGet: a pair key inherits its home value; longest prefix wins; NIFTY keys read as themselves", () => {
  const e = { EMA_RSI_ST_V2_EMA_FAST: "9", EMA_RSI_ST_EMA_FAST: "33" };
  assert.strictEqual(pairs.envGet("BN_EMA_RSI_ST_V2_EMA_FAST", e), "9");
  assert.strictEqual(pairs.envGet("BN_EMA_RSI_ST_V2_EMA_FAST", { ...e, BN_EMA_RSI_ST_V2_EMA_FAST: "11" }), "11");
  assert.strictEqual(pairs.envGet("BN_EMA_RSI_ST_EMA_FAST", e), "33");
  assert.strictEqual(pairs.envGet("EMA_RSI_ST_V2_EMA_FAST", {}), undefined);
  const engine = require("../src/strategies/ema_rsi_st_v2");
  withEnv({ EMA_RSI_ST_V2_EMA_FAST: "15", SENSEX_EMA_RSI_ST_V2_RSI_CE_MIN: "60" }, () => {
    const c = engine.getConfig("SENSEX_EMA_RSI_ST_V2");
    assert.deepStrictEqual([c.EMA_FAST, c.RSI_CE_MIN, c.RSI_PE_MAX], [15, 60, 48]);
  });
});
check("generic socket slots: one per pair, independent of NIFTY's", () => {
  const sss = require("../src/utils/sharedSocketState");
  const bn = rtOf("BANKNIFTY").socketSlot, sx = rtOf("SENSEX").socketSlot;
  assert.strictEqual(bn.canStart({ reserve: false }).allowed, true);
  bn.set();
  try {
    assert.ok(bn.isActive() && !sx.isActive() && !sss.isEmaRsiStV2Active());
    assert.ok(sss.isAnyActive());
    assert.deepStrictEqual(sss.heldSlots(), ["BN_EMA_RSI_ST_V2_PAPER"]);
    assert.strictEqual(bn.canStart({ reserve: false }).allowed, false);
    assert.strictEqual(sx.canStart({ reserve: false }).allowed, true);
  } finally { bn.clear(); }
  assert.ok(!bn.isActive() && !sss.isAnyActive());
});
check("pair crash snapshots: own file per pair; boot helpers find them", () => {
  const pp = require("../src/utils/positionPersist");
  rtOf("SENSEX").persist.save({ side: "CE", symbol: "BSE:SENSEX26N1280100CE", entryPrice: 80050 }, { sessionPnl: 0 });
  pp._flushSync && pp._flushSync();
  return new Promise(r => setTimeout(r, 50)).then(() => {
    const f = path.join(SANDBOX, "trading-data", ".active_sensex_ema_rsi_st_v2_position.json");
    assert.ok(fs.existsSync(f), "no .active_sensex_ema_rsi_st_v2_position.json");
    assert.strictEqual(pp.loadPairPosition("sensex_ema_rsi_st_v2").position.symbol, "BSE:SENSEX26N1280100CE");
    assert.ok(pp.loadPairPositions().sensex_ema_rsi_st_v2);
    pp.clearPairPositions();
    return new Promise(r => setTimeout(r, 50)).then(() => assert.ok(!fs.existsSync(f), "boot clean-up left it"));
  });
});
check("logs: a pair logs under its own mode key; the registry maps are untouched", () => {
  const tl = require("../src/utils/tradeLogger"), sl = require("../src/utils/skipLogger");
  assert.ok(tl.dailyFilePathFor("sensex_ema_rsi_st_v2", "2026-11-12").endsWith("trades/sensex_ema_rsi_st_v2_paper_trades_2026-11-12.jsonl"));
  assert.ok(sl.filePathFor("bn_ema_rsi_st_v2", "2026-11-12").endsWith("skips/bn_ema_rsi_st_v2_paper_skips_2026-11-12.jsonl"));
  assert.ok(!("sensex_ema_rsi_st_v2" in tl.DAILY_PREFIX_BY_MODE));
  assert.ok(tl.modes().includes("sensex_ema_rsi_st_v2") && sl.modes().includes("fut_ema_rsi_st_v2"));
  assert.throws(() => tl.dailyFilePathFor("bn_orb"), /unknown mode/, "a pair that does not run has no log");
});
check("market tags: a pair names its market and its strategy", () => {
  const tags = require("../src/utils/logTags");
  assert.deepStrictEqual(tags.tagsFor("sensex_ema_rsi_st_v2", {}), { market: "SENSEX", strategy: "EMA_RSI_ST_V2" });
  assert.deepStrictEqual(tags.tagsFor("ema_rsi_st_v2", {}), { market: "NIFTY", strategy: "EMA_RSI_ST_V2" });
  assert.strictEqual(require("../src/utils/tradeSources").marketOf("fut_ema_rsi_st_v2"), "NIFTY_FUT");
});
check("common trade window: a pair's OWN entry window is overridden and restored; an unset one inherits", () => {
  const ctw = require("../src/utils/commonTradeWindow");
  withEnv({ COMMON_TRADE_WINDOW_ENABLED: "true", EMA_RSI_ST_V2_ENTRY_START: "10:30", SENSEX_EMA_RSI_ST_V2_ENTRY_START: "09:40", BN_EMA_RSI_ST_V2_ENTRY_START: undefined }, () => {
    ctw.apply();
    try {
      assert.strictEqual(process.env.SENSEX_EMA_RSI_ST_V2_ENTRY_START, ctw.ENTRY_START, "own value overridden");
      assert.strictEqual(process.env.BN_EMA_RSI_ST_V2_ENTRY_START, undefined, "an unset pair key is not written");
      assert.strictEqual(pairs.envGet("BN_EMA_RSI_ST_V2_ENTRY_START"), ctw.ENTRY_START, "it inherits NIFTY's overridden window");
      process.env.COMMON_TRADE_WINDOW_ENABLED = "false";
      ctw.apply();
      assert.strictEqual(process.env.SENSEX_EMA_RSI_ST_V2_ENTRY_START, "09:40", "own value restored");
      assert.strictEqual(process.env.EMA_RSI_ST_V2_ENTRY_START, "10:30");
    } finally { process.env.COMMON_TRADE_WINDOW_ENABLED = "false"; ctw.apply(); }
  });
});
check("SENSEX stays marketOnly until a running SENSEX pair is switched on", () => {
  assert.strictEqual(instrument.isUnderlyingEnabled("SENSEX"), false);
  assert.ok(!instrument.listUnderlyings().some(u => u.key === "SENSEX"));
  withEnv({ SENSEX_EMA_RSI_ST_V2_MODE_ENABLED: "true" }, () => {
    assert.strictEqual(instrument.isUnderlyingEnabled("SENSEX"), true);
    assert.ok(instrument.listUnderlyings().some(u => u.key === "SENSEX"));
    assert.strictEqual(require("../src/config/markets").get("SENSEX").traded, true);
  });
  // A pair that does not run lifts nothing.
  withEnv({ SENSEX_ORB_MODE_ENABLED: "true" }, () => assert.strictEqual(instrument.isUnderlyingEnabled("SENSEX"), false));
});

// ─────────────────────────────────────────────────────────────────────────────
// Async checks above return promises; wait for them before reporting.
(async () => {
  await _runChecks();
  console.log(`\n${fail ? "❌" : "✅"} pairRuntime: ${pass} passed, ${fail} failed`);
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (_) {}
  process.exit(fail ? 1 : 0);
})();

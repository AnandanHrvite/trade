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
 *   • EMA_RSI_ST (V1): its pairs' identity, slots, legacy TRADE_* inheritance,
 *     the forPrefix engine window and the one builder route file
 *   • HA SCALP: its pairs' identity, engine config per pair, the route
 *     builder's instances, a switched-off pair refusing /start
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
  if (/(_MODE_ENABLED|_EXPIRY_DAY_ONLY|_PAPER_FILL_AT_QUOTE|_MAX_SPREAD_PTS|_OPTION_EXPIRY_OVERRIDE|_OPTION_EXPIRY_TYPE)$|^(MAX_BID_ASK_SPREAD_PTS|LOT_MULTIPLIER|EMA_RSI_ST_V2_|TDS_|HA_SCALP_)/.test(k)) delete process.env[k];
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
check("running pairs = every offered non-home pair of a RUNS_AS_PAIR strategy; none other runs", () => {
  const MK = ["NIFTY_FUT", "BANKNIFTY", "SENSEX", "CRUDE", "GOLD", "SILVER", "SAIL"];
  // Strategies that need the 09:15 index open are never offered on MCX.
  const NO_MCX = ["NIFTY_FUT", "BANKNIFTY", "SENSEX", "SAIL"];
  const WANT = { emaRsiStV2: MK, emaRsiSt: MK, bbRsi: MK, pa: MK, orb: NO_MCX, ema9vwap: MK, trendPb: MK, trendDayScalp: MK, haScalp: MK, rsiPivotSt: MK, pivotEmaSt: MK };
  for (const id of Object.keys(WANT)) {
    assert.deepStrictEqual(pairs.runnable().filter(p => p.strategyId === id).map(p => p.marketKey), WANT[id], id);
  }
  assert.deepStrictEqual([...pairs.RUNS_AS_PAIR].sort(), Object.keys(WANT).sort(), "every RUNS_AS_PAIR strategy has its expected markets here");
  assert.strictEqual(pairs.byReplayMode("sensex_orb-paper").marketKey, "SENSEX");
  assert.strictEqual(pairs.byReplayMode("orb-paper"), null, "ORB's home mode is the registry's");
  assert.ok(pairs.all().filter(p => p.runs).every(p => pairs.RUNS_AS_PAIR.has(p.strategyId)));
  assert.strictEqual(pairs.byReplayMode("bn_ema_rsi_st_v2-paper").marketKey, "BANKNIFTY");
  assert.strictEqual(pairs.byReplayMode("ema_rsi_st_v2-paper"), null, "the home mode is the registry's");
  assert.strictEqual(pairs.byReplayMode("sensex_pa-paper").id, "pa@SENSEX");
  assert.strictEqual(pairs.byReplayMode("pa-paper"), null, "PA's home mode is the registry's");
});

check("Price Action: NIFTY is the registry's PA; other markets get their own keys, paths, files and slots", () => {
  const n = pairRuntime.forStrategy("pa", "NIFTY");
  assert.deepStrictEqual(
    [n.home, n.modeKey, n.envPrefix, n.paperPath, n.replayMode, n.ownerId, n.tradesFile, n.socketSlot.mode, n.notifyMode, n.sidebarKey, n.historySidebarKey, n.tag],
    [true, "pa", "PA", "/pa-paper", "pa-paper", "pa-paper", "pa_paper_trades.json", "PA_PAPER", "PA-PAPER", "paPaper", "paHistory", "PA"]);
  assert.strictEqual(n.oiApplies, true);
  const s = pairRuntime.forStrategy("pa", "SENSEX"), f = pairRuntime.forStrategy("pa", "NIFTY_FUT");
  assert.deepStrictEqual([s.paperPath, s.tradesFile, s.modeKey, s.envPrefix, s.socketSlot.mode, s.oiApplies], ["/sensex_pa-paper", "sensex_pa_paper_trades.json", "sensex_pa", "SENSEX_PA", "SENSEX_PA_PAPER", false]);
  assert.deepStrictEqual([f.isFutures, f.instrumentName(), f.paperPath], [true, "NIFTY_FUTURES", "/fut_pa-paper"]);
  // PA's own keys inherit; a PA pair key never resolves to another strategy's.
  withEnv({ PA_SMC_MIN_RR: "2", BN_PA_SMC_MIN_RR: undefined, BN_PIVOT_EMA_ST_X: "9" }, () => {
    assert.strictEqual(pairs.envGet("BN_PA_SMC_MIN_RR"), "2");
    assert.strictEqual(pairs.envGet("PA_SMC_MIN_RR"), "2");
  });
  withEnv({ PA_EXPIRY_DAY_ONLY: "true", SENSEX_PA_EXPIRY_DAY_ONLY: undefined }, () => assert.strictEqual(s.expiryDayOnly(), true));
  withEnv({ PA_EXPIRY_DAY_ONLY: "true", SENSEX_PA_EXPIRY_DAY_ONLY: "false" }, () => assert.strictEqual(s.expiryDayOnly(), false));
});
check("every pair ships OFF", () => {
  for (const p of pairs.runnable()) assert.strictEqual(pairRuntime.forPair(p).enabled(), false, p.id);
});

// ─────────────────────────────────────────────────────────────────────────────
section("EMA9+VWAP runs as a pair");

const e9Of = (mk) => pairRuntime.forStrategy("ema9vwap", mk);
check("NIFTY EMA9+VWAP is the home pair: the old keys, path, file, slot; OI is NIFTY-only", () => {
  const rt = e9Of("NIFTY");
  assert.deepStrictEqual([rt.home, rt.modeKey, rt.envPrefix, rt.paperPath, rt.tradesFile, rt.ownerId, rt.socketSlot.mode, rt.notifyMode, rt.oiApplies],
    [true, "ema9vwap", "EMA9VWAP", "/ema9vwap-paper", "ema9vwap_paper_trades.json", "ema9vwap-paper", "EMA9VWAP_PAPER", "EMA9VWAP-PAPER", true]);
  for (const [mk, pre] of [["BANKNIFTY", "bn"], ["SENSEX", "sensex"], ["NIFTY_FUT", "fut"]]) {
    const r = e9Of(mk);
    assert.deepStrictEqual([r.home, r.modeKey, r.envPrefix, r.paperPath, r.tradesFile, r.socketSlot.mode, r.oiApplies],
      [false, `${pre}_ema9vwap`, `${pre.toUpperCase()}_EMA9VWAP`, `/${pre}_ema9vwap-paper`, `${pre}_ema9vwap_paper_trades.json`, `${pre.toUpperCase()}_EMA9VWAP_PAPER`, false], mk);
  }
  assert.strictEqual(e9Of("NIFTY_FUT").instrumentName(), "NIFTY_FUTURES");
});
check("ema9vwapPaper exports the NIFTY router; forMarket builds one memoised router per offered market", () => {
  const R = require("../src/routes/ema9vwapPaper");
  assert.strictEqual(typeof R, "function", "the default export must still be an express router");
  assert.strictEqual(R.forMarket("NIFTY"), R, "the home instance is the default export");
  assert.strictEqual(R.pairRuntime, e9Of("NIFTY"));
  const bn = R.forMarket("BANKNIFTY");
  assert.ok(bn && bn !== R, "BANKNIFTY gets its own router");
  assert.strictEqual(R.forMarket("BANKNIFTY"), bn, "forMarket is memoised (one engine per market)");
  assert.notStrictEqual(R.forMarket("SENSEX"), bn);
  assert.strictEqual(R.forMarket("NOPE"), null);
  assert.strictEqual(R.forPair(pairs.get("ema9vwap", "NIFTY_FUT")), R.forMarket("NIFTY_FUT"));
  assert.strictEqual(typeof bn.stopSession, "function", "a pair router must expose stopSession for the shutdown square-off");
});
check("the EMA9+VWAP engine reads a pair's own key, else inherits NIFTY's", () => {
  const eng = require("../src/strategies/ema9_vwap");
  const t = Math.floor(istMs("2026-09-17", 10, 10) / 1000);   // a 5m bar closing 10:15
  withEnv({ EMA9VWAP_ENTRY_START: undefined, BN_EMA9VWAP_ENTRY_START: undefined }, () => {
    assert.deepStrictEqual([eng.isEntryWindowOpen(t, 5), eng.isEntryWindowOpen(t, 5, "BN_EMA9VWAP")], [false, false], "default window opens 10:30");
  });
  withEnv({ EMA9VWAP_ENTRY_START: "10:00", BN_EMA9VWAP_ENTRY_START: undefined }, () => {
    assert.strictEqual(eng.forPrefix("BN_EMA9VWAP").isEntryWindowOpen(t, 5), true, "an unset pair key inherits NIFTY's value");
  });
  withEnv({ EMA9VWAP_ENTRY_START: undefined, BN_EMA9VWAP_ENTRY_START: "10:00" }, () => {
    assert.deepStrictEqual([eng.isEntryWindowOpen(t, 5), eng.isEntryWindowOpen(t, 5, "BN_EMA9VWAP"), eng.isEntryWindowOpen(t, 5, "SENSEX_EMA9VWAP")], [false, true, false],
      "a pair key must not leak into NIFTY or another pair");
  });
});
check("ema9vwapPaper: per-market facts come from rt; journal hooks + NIFTY-only OI are wired", () => {
  const code = fs.readFileSync(path.join(__dirname, "../src/routes/ema9vwapPaper.js"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/ [^\n]*$/gm, "");
  assert.ok(/function create\(pair\)\s*\{\s*const rt\s*=\s*pairRuntime\.forPair\(pair\)/.test(code), "create(pair) builder");
  assert.ok(/const ROUTE\s*=\s*rt\.paperPath;/.test(code) && /const MODE\s*=\s*rt\.modeKey;/.test(code), "path / mode key must come from rt");
  assert.ok(!/["'`]\/ema9vwap-paper/.test(code), "no literal NIFTY route path");
  assert.ok(!/NSE:NIFTY50-INDEX/.test(code), "the spot symbol must come from rt");
  assert.ok(!/\(\s*"ema9vwap"\s*[,)]/.test(code.replace(/vixFilter\.\w+\("ema9vwap"\)|\{ mode: "ema9vwap" \}|validateAndGetOptionSymbol\(spot, side, "ema9vwap"\)|pairs\.get\("ema9vwap"/g, "")),
    "a literal \"ema9vwap\" mode key outside the VIX mode / NIFTY symbol call");
  for (const h of ["onEntry", "onTick", "onStopChange", "onExit", "fields"]) {
    assert.ok(new RegExp(`tradeJournal\\.${h}\\(`).test(code), `tradeJournal.${h} hook missing`);
  }
  assert.ok(/rt\.oiApplies && oiFilter\.getOiEnabled\(MODE\)/.test(code), "the OI gate must stay NIFTY-only");
  // NIFTY's symbol lookup stays a DIRECT call: pairRuntime's async wrapper adds a
  // microtask hop that lost the prefetch race and moved a NIFTY entry's strike.
  assert.ok(/rt\.home \? validateAndGetOptionSymbol\(spot, side, "ema9vwap"\) : rt\.resolveEntrySymbol\(spot, side\)/.test(code),
    "NIFTY must call validateAndGetOptionSymbol directly");
});
check("ema9vwapPaper: a pair's own VIX switch (Settings → that market) drives its gate", () => {
  const R = require("../src/routes/ema9vwapPaper");
  const vixOn = (router) => {
    const layer = router.stack.find(l => l.route && l.route.path === "/status" && l.route.methods.get);
    let html = "";
    layer.route.stack[0].handle({ query: {}, headers: {} }, { send: (h) => { html = h; }, setHeader() {}, set() {}, status() { return this; }, json() {} });
    return /🌡️ VIX (n\/a|\d)/.test(html);
  };
  const S = R.forMarket("SENSEX");
  withEnv({ VIX_FILTER_ENABLED: "false", EMA9VWAP_VIX_ENABLED: undefined, SENSEX_EMA9VWAP_VIX_ENABLED: undefined }, () =>
    assert.deepStrictEqual([vixOn(R), vixOn(S)], [false, false]));
  withEnv({ VIX_FILTER_ENABLED: "false", EMA9VWAP_VIX_ENABLED: undefined, SENSEX_EMA9VWAP_VIX_ENABLED: "true" }, () =>
    assert.deepStrictEqual([vixOn(R), vixOn(S)], [false, true], "SENSEX's own key ON must not need NIFTY's"));
  withEnv({ VIX_FILTER_ENABLED: "false", EMA9VWAP_VIX_ENABLED: "true", SENSEX_EMA9VWAP_VIX_ENABLED: undefined }, () =>
    assert.deepStrictEqual([vixOn(R), vixOn(S)], [true, true], "an unset pair key inherits NIFTY's"));
  withEnv({ VIX_FILTER_ENABLED: undefined, EMA9VWAP_VIX_ENABLED: "true", SENSEX_EMA9VWAP_VIX_ENABLED: "false" }, () =>
    assert.deepStrictEqual([vixOn(R), vixOn(S)], [true, false], "SENSEX's own key OFF wins over NIFTY's"));
  withEnv({ VIX_FILTER_ENABLED: undefined, EMA9VWAP_VIX_ENABLED: undefined, SENSEX_EMA9VWAP_VIX_ENABLED: undefined }, () =>
    assert.deepStrictEqual([vixOn(R), vixOn(S)], [true, true], "unset everywhere: the global key's tri-state default (ON) for both"));
});
check("ema9vwapPaper: a pair's /start refuses while its own switch is off, and binds its own spot feed", () => {
  // The Fyers token check runs first (no login in this sandbox), so the gates are
  // pinned in the source rather than exercised.
  const code = fs.readFileSync(path.join(__dirname, "../src/routes/ema9vwapPaper.js"), "utf8");
  const start = code.slice(code.indexOf('router.get("/start"'), code.indexOf('router.get("/stop"'));
  assert.ok(/if \(!rt\.home && !rt\.enabled\(\)\) \{\s*return res\.status\(403\)/.test(start), "/start must refuse a switched-off pair");
  assert.ok(/rt\.home \? await isTradingAllowed\(\) : await rt\.isTradingAllowed\(\)/.test(start), "a pair checks its own exchange calendar");
  assert.ok(/addCallback\(CALLBACK_ID, onTick, log, _cbSym\)/.test(start) && /const _cbSym = rt\.home \? undefined : subscribeSymbol;/.test(start),
    "a pair binds its socket callback to its own spot symbol; NIFTY stays unbound (default feed)");
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
  assert.throws(() => tl.dailyFilePathFor("bn_st_rsi_piv_bb"), /unknown mode/, "a pair that does not run has no log");
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
  withEnv({ SENSEX_ST_RSI_PIV_BB_MODE_ENABLED: "true" }, () => assert.strictEqual(instrument.isUnderlyingEnabled("SENSEX"), false));
  // A running ORB pair does.
  withEnv({ SENSEX_ORB_MODE_ENABLED: "true" }, () => assert.strictEqual(instrument.isUnderlyingEnabled("SENSEX"), true));
});

// ─────────────────────────────────────────────────────────────────────────────
section("ORB runs as a pair (routes/orbPaper.js)");

const orbOf = (mk) => pairRuntime.forStrategy("orb", mk);
check("NIFTY is the registry's ORB; other markets get their own path, file, slot", () => {
  const n = orbOf("NIFTY"), bn = orbOf("BANKNIFTY");
  assert.deepStrictEqual(
    [n.home, n.modeKey, n.envPrefix, n.paperPath, n.replayMode, n.tradesFile, n.socketSlot.mode, n.notifyMode, n.sidebarKey, n.historySidebarKey, n.spotLabel, n.oiApplies],
    [true, "orb", "ORB", "/orb-paper", "orb-paper", "orb_paper_trades.json", "ORB_PAPER", "ORB-PAPER", "orbPaper", "orbHistory", "NIFTY", true]);
  assert.deepStrictEqual([bn.paperPath, bn.tradesFile, bn.modeKey, bn.socketSlot.mode, bn.notifyMode, bn.oiApplies],
    ["/bn_orb-paper", "bn_orb_paper_trades.json", "bn_orb", "BN_ORB_PAPER", "BN_ORB-PAPER", false]);
  assert.strictEqual(orbOf("SENSEX").paperPath, "/sensex_orb-paper");
  assert.strictEqual(orbOf("NIFTY_FUT").instrumentName(), "NIFTY_FUTURES");
  assert.strictEqual(orbOf("CRUDE"), null, "ORB is not offered on MCX");
  for (const mk of ["BANKNIFTY", "SENSEX", "NIFTY_FUT", "SAIL"]) assert.strictEqual(orbOf(mk).enabled(), false, `${mk} ships OFF`);
});
check("the NIFTY instance holds ORB's own named slot; a pair holds its own", () => {
  const sss = require("../src/utils/sharedSocketState");
  const slot = orbOf("NIFTY").socketSlot;
  slot.set();
  try { assert.ok(sss.isOrbActive() && !orbOf("BANKNIFTY").socketSlot.isActive()); }
  finally { slot.clear(); }
  assert.ok(!sss.isOrbActive());
  const bn = orbOf("BANKNIFTY").socketSlot;
  bn.set();
  try { assert.ok(bn.isActive() && !sss.isOrbActive() && !rtOf("BANKNIFTY").socketSlot.isActive(), "V2's BANKNIFTY slot is a different one"); }
  finally { bn.clear(); }
});
check("engine: a pair prefix reads its own ORB keys, else NIFTY's; no prefix reads NIFTY only", () => {
  const eng = require("../src/strategies/orb_breakout");
  const t = Math.floor(istMs("2026-11-12", 9, 20) / 1000);
  const c = [{ time: t - 300, open: 1, high: 1, low: 1, close: 1 }, { time: t, open: 1, high: 1, low: 1, close: 1 }];
  withEnv({ ORB_RANGE_END: "09:30", BN_ORB_RANGE_END: undefined, SENSEX_ORB_RANGE_END: "09:45" }, () => {
    assert.strictEqual(eng.getSignal(c, { silent: true }).reason, "Building opening range (waiting for 09:30 IST)");
    assert.strictEqual(eng.getSignal(c, { silent: true, prefix: "BN_ORB" }).reason, "Building opening range (waiting for 09:30 IST)", "inherits NIFTY's");
    assert.strictEqual(eng.getSignal(c, { silent: true, prefix: "SENSEX_ORB" }).reason, "Building opening range (waiting for 09:45 IST)", "own value wins");
  });
  const t10 = Math.floor(istMs("2026-11-12", 10, 0) / 1000);
  const c10 = [{ time: t10 - 300, open: 1, high: 1, low: 1, close: 1 }, { time: t10, open: 1, high: 1, low: 1, close: 1 }];
  withEnv({ ORB_ENTRY_END: undefined, BN_ORB_ENTRY_END: "09:50", ORB_RANGE_END: undefined, ORB_ENTRY_START: undefined }, () => {
    assert.ok(!/^Past /.test(eng.getSignal(c10, { silent: true }).reason), "NIFTY never reads a pair key");
    assert.strictEqual(eng.getSignal(c10, { silent: true, prefix: "BN_ORB" }).reason, "Past 09:50 IST — no new ORB entries (breakout is stale)");
  });
  // the opening range itself follows the pair's window
  const day = [9 * 60 + 15, 9 * 60 + 20, 9 * 60 + 25, 9 * 60 + 30].map((m, i) => ({ time: Math.floor(istMs("2026-11-12", 0, m) / 1000), open: 100, high: 100 + i, low: 100 - i, close: 100 }));
  withEnv({ ORB_RANGE_END: undefined, SENSEX_ORB_RANGE_END: "09:35" }, () => {
    assert.deepStrictEqual([eng.computeOpeningRange(day).high, eng.computeOpeningRange(day, "SENSEX_ORB").high], [102, 103]);
  });
});
check("route: one builder serves every offered market; NIFTY is the default export", () => {
  const route = require("../src/routes/orbPaper");
  assert.strictEqual(route.forMarket("NIFTY"), route);
  assert.strictEqual(route.pairRuntime.home, true);
  const bn = route.forMarket("BANKNIFTY");
  assert.ok(bn && bn !== route && typeof bn.stopSession === "function" && typeof route.stopSession === "function");
  assert.strictEqual(bn.pairRuntime.modeKey, "bn_orb");
  assert.strictEqual(route.forMarket("BANKNIFTY"), bn, "one instance per pair");
  assert.strictEqual(route.forMarket("CRUDE"), null);
  for (const p of pairs.runnable().filter(x => x.strategyId === "orb")) assert.ok(route.forPair(p), p.id);
});
check("route source: market facts come from the runtime, the journal is hooked, OI stays NIFTY-only", () => {
  const src = fs.readFileSync(path.join(__dirname, "../src/routes/orbPaper.js"), "utf8");
  assert.ok(!/NSE:NIFTY50-INDEX/.test(src), "a spot symbol is typed in the route");
  assert.ok(!/(capitalPool|skipLogger|tradeLogger)\.\w+\("orb"/.test(src), "the mode key is typed in the route");
  assert.ok(/rt\.oiApplies && oiFilter\.getOiEnabled\(MODE\)/.test(src) && /if \(rt\.oiApplies\) await oiFilter\.recordOiSample/.test(src));
  for (const h of ["onEntry", "onTick", "onStopChange", "onExit", "fields"]) assert.ok(src.includes(`tradeJournal.${h}(`), `tradeJournal.${h} not hooked`);
});

// ─────────────────────────────────────────────────────────────────────────────
section("EMA_RSI_ST (V1) pairs");

const v1Of = (mk) => pairRuntime.forStrategy("emaRsiSt", mk);
check("V1 NIFTY is the home pair: registry keys, path, file, primary slot, sidebar", () => {
  const rt = v1Of("NIFTY");
  assert.deepStrictEqual(
    [rt.home, rt.isNiftyHome, rt.modeKey, rt.envPrefix, rt.paperPath, rt.replayMode, rt.tradesFile, rt.socketSlot.mode, rt.sidebarKey, rt.historySidebarKey],
    [true, true, "ema_rsi_st", "EMA_RSI_ST", "/ema_rsi_st-paper", "ema_rsi_st-paper", "ema_rsi_st_paper_trades.json", "EMA_RSI_ST_PAPER", "emaRsiStPaper", "emaRsiStHistory"]);
  assert.strictEqual(rt.oiApplies, true);
});
check("V1 pairs: own path, file, mode key, slot, tag per market (never V2's)", () => {
  const rows = ["SENSEX", "BANKNIFTY", "NIFTY_FUT", "CRUDE", "SAIL"].map(mk => {
    const r = v1Of(mk);
    return [mk, r.paperPath, r.tradesFile, r.modeKey, r.socketSlot.mode, r.notifyMode, r.oiApplies];
  });
  assert.deepStrictEqual(rows, [
    ["SENSEX", "/sensex_ema_rsi_st-paper", "sensex_ema_rsi_st_paper_trades.json", "sensex_ema_rsi_st", "SENSEX_EMA_RSI_ST_PAPER", "SENSEX_EMA_RSI_ST-PAPER", false],
    ["BANKNIFTY", "/bn_ema_rsi_st-paper", "bn_ema_rsi_st_paper_trades.json", "bn_ema_rsi_st", "BN_EMA_RSI_ST_PAPER", "BN_EMA_RSI_ST-PAPER", false],
    ["NIFTY_FUT", "/fut_ema_rsi_st-paper", "fut_ema_rsi_st_paper_trades.json", "fut_ema_rsi_st", "FUT_EMA_RSI_ST_PAPER", "FUT_EMA_RSI_ST-PAPER", false],
    ["CRUDE", "/crude_ema_rsi_st-paper", "crude_ema_rsi_st_paper_trades.json", "crude_ema_rsi_st", "CRUDE_EMA_RSI_ST_PAPER", "CRUDE_EMA_RSI_ST-PAPER", false],
    ["SAIL", "/sail_ema_rsi_st-paper", "sail_ema_rsi_st_paper_trades.json", "sail_ema_rsi_st", "SAIL_EMA_RSI_ST_PAPER", "SAIL_EMA_RSI_ST-PAPER", false],
  ]);
  assert.strictEqual(pairs.byReplayMode("bn_ema_rsi_st-paper").strategyId, "emaRsiSt");
  assert.strictEqual(pairs.byReplayMode("bn_ema_rsi_st_v2-paper").strategyId, "emaRsiStV2");
  assert.strictEqual(pairs.byReplayMode("ema_rsi_st-paper"), null, "the home mode is the registry's");
});
check("V1 slots: NIFTY holds the primary EMA_RSI_ST slot; a V1 pair, V2's pair and NIFTY are independent", () => {
  const sss = require("../src/utils/sharedSocketState");
  const home = v1Of("NIFTY").socketSlot, bn = v1Of("BANKNIFTY").socketSlot, bnV2 = rtOf("BANKNIFTY").socketSlot;
  bn.set();
  try {
    assert.ok(bn.isActive() && !bnV2.isActive() && !sss.isActive(), "BN V1 pair slot only");
    assert.strictEqual(bnV2.canStart({ reserve: false }).allowed, true);
    assert.strictEqual(home.canStart({ reserve: false }).allowed, true);
    home.set();
    assert.ok(sss.isActive() && sss.getMode() === "EMA_RSI_ST_PAPER", "NIFTY's is the registry's primary slot");
  } finally { bn.clear(); home.clear(); }
  assert.ok(!sss.isAnyActive());
});
check("V1 keys: a pair inherits EMA_RSI_ST_* and the legacy TRADE_* keys; pairKey maps both", () => {
  const e = { EMA_RSI_ST_EMA_FAST: "33", TRADE_ENTRY_START: "10:00", EMA_RSI_ST_V2_EMA_FAST: "9" };
  assert.strictEqual(pairs.envGet("SENSEX_EMA_RSI_ST_EMA_FAST", e), "33");
  assert.strictEqual(pairs.envGet("SENSEX_EMA_RSI_ST_ENTRY_START", e), "10:00", "legacy TRADE_ENTRY_START");
  assert.strictEqual(pairs.envGet("SENSEX_EMA_RSI_ST_V2_EMA_FAST", e), "9", "the V2 pair still reads V2's key");
  const p = pairs.get("emaRsiSt", "BANKNIFTY");
  assert.strictEqual(pairs.pairKey(p, "TRADE_ENTRY_START"), "BN_EMA_RSI_ST_ENTRY_START");
  assert.strictEqual(pairs.pairKey(p, "TRADE_EXPIRY_DAY_ONLY"), null, "the shared expiry switch is not per pair");
});
check("V1 engine: forPrefix reads the pair's own window / keys, NIFTY's when unset", () => {
  const v1 = require("../src/strategies/strategy1_sar_ema_rsi");
  const t = Math.floor(istMs("2026-11-10", 9, 50) / 1000);
  withEnv({ TRADE_ENTRY_START: "10:00", SENSEX_EMA_RSI_ST_ENTRY_START: undefined, EMA_RSI_ST_ENTRY_START: undefined }, () => {
    assert.strictEqual(v1.isInTradingWindow(t).ok, false, "NIFTY: before 10:00");
    assert.strictEqual(v1.forPrefix("SENSEX_EMA_RSI_ST").isInTradingWindow(t).ok, false, "unset pair inherits 10:00");
    process.env.SENSEX_EMA_RSI_ST_ENTRY_START = "09:40";
    assert.strictEqual(v1.forPrefix("SENSEX_EMA_RSI_ST").isInTradingWindow(t).ok, true, "own 09:40");
    assert.strictEqual(v1.isInTradingWindow(t).ok, false, "NIFTY unchanged");
  });
});
check("V1 route: one builder file; NIFTY default export, one router per pair with its own runtime", () => {
  const mod = require("../src/routes/emaRsiStPaper");
  assert.strictEqual(typeof mod.create, "function");
  assert.strictEqual(mod.forMarket("NIFTY"), mod, "the default export is the NIFTY instance");
  assert.strictEqual(mod.pairRuntime.home, true);
  const sx = mod.forMarket("SENSEX"), bn = mod.forPair(pairs.get("emaRsiSt", "BANKNIFTY"));
  assert.ok(sx && bn && sx !== bn && sx !== mod);
  assert.strictEqual(mod.forMarket("SENSEX"), sx, "memoised");
  assert.deepStrictEqual([sx.pairRuntime.paperPath, bn.pairRuntime.paperPath], ["/sensex_ema_rsi_st-paper", "/bn_ema_rsi_st-paper"]);
  for (const r of [mod, sx, bn]) assert.strictEqual(typeof r.stopSession, "function");
  const src = fs.readFileSync(path.join(__dirname, "../src/routes/emaRsiStPaper.js"), "utf8");
  assert.ok(/if \(rt\.home\) \{[^}]*socketManager\.start\(subscribeSymbol, onTick, log\)/.test(src), "NIFTY keeps the primary socket handler");
  assert.ok(/socketManager\.addCallback\(OWNER, onTick, log, subscribeSymbol\)/.test(src), "a pair fans out through addCallback");
  assert.ok(/const NOTIFY_MODE = rt\.home \? "PAPER" : rt\.notifyMode;/.test(src), "NIFTY alerts keep the PAPER tag");
  assert.ok(/rt\.oiApplies && oiFilter\.getOiEnabled\(MODE\)/.test(src), "the OI gate stays NIFTY-only");
  assert.ok(/if \(!rt\.enabled\(\)\) \{\s*return res\.status\(403\)/.test(src), "a pair's /start refuses while <PAIR>_MODE_ENABLED is off");
});
section("BB_RSI runs as a pair");

const bbOf = (mk) => pairRuntime.forStrategy("bbRsi", mk);
check("NIFTY BB_RSI is the home pair: the old keys, path, file, slot; OI is NIFTY-only", () => {
  const rt = bbOf("NIFTY");
  assert.deepStrictEqual([rt.home, rt.modeKey, rt.envPrefix, rt.paperPath, rt.tradesFile, rt.socketSlot.mode, rt.notifyMode, rt.oiApplies],
    [true, "bb_rsi", "BB_RSI", "/bb_rsi-paper", "bb_rsi_paper_trades.json", "BB_RSI_PAPER", "BB_RSI-PAPER", true]);
  for (const [mk, pre] of [["BANKNIFTY", "bn"], ["SENSEX", "sensex"], ["NIFTY_FUT", "fut"]]) {
    const r = bbOf(mk);
    assert.deepStrictEqual([r.home, r.modeKey, r.envPrefix, r.paperPath, r.tradesFile, r.oiApplies],
      [false, `${pre}_bb_rsi`, `${pre.toUpperCase()}_BB_RSI`, `/${pre}_bb_rsi-paper`, `${pre}_bb_rsi_paper_trades.json`, false], mk);
  }
});
check("bbRsiPaper exports the NIFTY router; forMarket builds one memoised router per offered market", () => {
  const R = require("../src/routes/bbRsiPaper");
  assert.strictEqual(typeof R, "function", "the default export must still be an express router");
  assert.strictEqual(R.forMarket("NIFTY"), R, "the home instance is the default export");
  const bn = R.forMarket("BANKNIFTY");
  assert.ok(bn && bn !== R, "BANKNIFTY gets its own router");
  assert.strictEqual(R.forMarket("BANKNIFTY"), bn, "forMarket is memoised (one engine per market)");
  assert.notStrictEqual(R.forMarket("SENSEX"), bn);
  assert.strictEqual(R.forMarket("NOPE"), null);
  assert.strictEqual(R.forPair(pairs.get("bbRsi", "NIFTY_FUT")), R.forMarket("NIFTY_FUT"));
});
check("the BB_RSI engine reads a pair's own key, else inherits NIFTY's", () => {
  const eng = require("../src/strategies/bb_rsi");
  withEnv({ BB_RSI_DIRECTION: undefined, BN_BB_RSI_DIRECTION: undefined }, () => {
    assert.deepStrictEqual([eng.direction(), eng.direction("BN_BB_RSI")], ["fade", "fade"]);
  });
  withEnv({ BB_RSI_DIRECTION: "breakout", BN_BB_RSI_DIRECTION: undefined }, () => {
    assert.strictEqual(eng.direction("BN_BB_RSI"), "breakout", "an unset pair key inherits NIFTY's value");
  });
  withEnv({ BB_RSI_DIRECTION: undefined, BN_BB_RSI_DIRECTION: "breakout" }, () => {
    assert.deepStrictEqual([eng.direction(), eng.direction("BN_BB_RSI"), eng.direction("SENSEX_BB_RSI")], ["fade", "breakout", "fade"],
      "a pair key must not leak into NIFTY or another pair");
  });
});
check("bbRsiPaper: per-market facts come from rt; journal hooks + NIFTY-only OI are wired", () => {
  const code = fs.readFileSync(path.join(__dirname, "../src/routes/bbRsiPaper.js"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.ok(/function create\(pair\)\s*\{\s*const rt\s*=\s*pairRuntime\.forPair\(pair\)/.test(code), "create(pair) builder");
  assert.ok(/const ROUTE\s*=\s*rt\.paperPath;/.test(code) && /const MODE\s*=\s*rt\.modeKey;/.test(code), "path / mode key must come from rt");
  assert.ok(!/router\.(get|post)\(\s*["'`]\/bb_rsi-paper/.test(code), "no literal NIFTY route path");
  assert.ok(!/NSE:NIFTY50-INDEX/.test(code), "the spot symbol must come from rt");
  for (const h of ["onEntry", "onTick", "onStopChange", "onExit", "fields"]) {
    assert.ok(new RegExp(`tradeJournal\\.${h}\\(`).test(code), `tradeJournal.${h} hook missing`);
  }
  assert.ok(/rt\.oiApplies && oiFilter\.getOiEnabled\(MODE\)/.test(code), "the OI gate must stay NIFTY-only");
});
check("bbRsiPaper: a pair's own VIX switch (Settings → that market) drives its gate, as in its backtest", () => {
  const R = require("../src/routes/bbRsiPaper");
  const vixOn = (router) => {
    const layer = router.stack.find(l => l.route && l.route.path === "/status" && l.route.methods.get);
    let html = "";
    layer.route.stack[0].handle({ query: {}, headers: {} }, { send: (h) => { html = h; }, setHeader() {}, set() {}, status() { return this; }, json() {} });
    return /VIX (n\/a|\d)/.test(html);
  };
  const S = R.forMarket("SENSEX");
  withEnv({ BB_RSI_VIX_ENABLED: undefined, SENSEX_BB_RSI_VIX_ENABLED: undefined }, () =>
    assert.deepStrictEqual([vixOn(R), vixOn(S)], [false, false]));
  withEnv({ BB_RSI_VIX_ENABLED: undefined, SENSEX_BB_RSI_VIX_ENABLED: "true" }, () =>
    assert.deepStrictEqual([vixOn(R), vixOn(S)], [false, true], "SENSEX's own key ON must not need NIFTY's"));
  withEnv({ BB_RSI_VIX_ENABLED: "true", SENSEX_BB_RSI_VIX_ENABLED: undefined }, () =>
    assert.deepStrictEqual([vixOn(R), vixOn(S)], [true, true], "an unset pair key inherits NIFTY's"));
  withEnv({ BB_RSI_VIX_ENABLED: "true", SENSEX_BB_RSI_VIX_ENABLED: "false" }, () =>
    assert.deepStrictEqual([vixOn(R), vixOn(S)], [true, false], "SENSEX's own key OFF wins over NIFTY's"));
});

// ─────────────────────────────────────────────────────────────────────────────
section("Trend Pullback runs as a pair (routes/trendPbPaper.js)");

const tpbOf = (mk) => pairRuntime.forStrategy("trendPb", mk);
check("NIFTY is the registry's Trend Pullback; other markets get their own path, file, slot", () => {
  const n = tpbOf("NIFTY"), bn = tpbOf("BANKNIFTY");
  assert.deepStrictEqual(
    [n.home, n.modeKey, n.envPrefix, n.paperPath, n.replayMode, n.tradesFile, n.socketSlot.mode, n.notifyMode, n.sidebarKey, n.historySidebarKey, n.spotLabel, n.oiApplies],
    [true, "trend_pb", "TREND_PB", "/trend-pb-paper", "trend-pb-paper", "trend_pb_paper_trades.json", "TREND_PB_PAPER", "TREND_PB-PAPER", "trendPbPaper", "trendPbHistory", "NIFTY", true]);
  assert.deepStrictEqual([bn.paperPath, bn.tradesFile, bn.modeKey, bn.socketSlot.mode, bn.notifyMode, bn.oiApplies],
    ["/bn_trend_pb-paper", "bn_trend_pb_paper_trades.json", "bn_trend_pb", "BN_TREND_PB_PAPER", "BN_TREND_PB-PAPER", false]);
  assert.strictEqual(tpbOf("SENSEX").paperPath, "/sensex_trend_pb-paper");
  assert.strictEqual(tpbOf("NIFTY_FUT").instrumentName(), "NIFTY_FUTURES");
  for (const mk of ["BANKNIFTY", "SENSEX", "NIFTY_FUT", "CRUDE", "SAIL"]) assert.strictEqual(tpbOf(mk).enabled(), false, `${mk} ships OFF`);
});
check("the NIFTY instance holds Trend Pullback's own named slot; a pair holds its own", () => {
  const sss = require("../src/utils/sharedSocketState");
  const slot = tpbOf("NIFTY").socketSlot;
  slot.set();
  try { assert.ok(sss.isTrendPbActive() && !tpbOf("BANKNIFTY").socketSlot.isActive()); }
  finally { slot.clear(); }
  assert.ok(!sss.isTrendPbActive());
  const bn = tpbOf("BANKNIFTY").socketSlot;
  bn.set();
  try { assert.ok(bn.isActive() && !sss.isTrendPbActive() && !rtOf("BANKNIFTY").socketSlot.isActive(), "V2's BANKNIFTY slot is a different one"); }
  finally { bn.clear(); }
});
check("engine: a pair prefix reads its own TREND_PB keys, else NIFTY's; no prefix reads NIFTY only", () => {
  const eng = require("../src/strategies/trend_pb");
  const t = Math.floor(istMs("2026-11-12", 10, 0) / 1000);
  const c = [{ time: t - 300, open: 1, high: 1, low: 1, close: 1 }, { time: t, open: 1, high: 1, low: 1, close: 1 }];
  withEnv({ TREND_PB_ENTRY_START: "12:00", BN_TREND_PB_ENTRY_START: undefined, SENSEX_TREND_PB_ENTRY_START: "11:00" }, () => {
    assert.strictEqual(eng.getSignal(c, { silent: true }).reason, "Before entry window (12:00 IST)");
    assert.strictEqual(eng.getSignal(c, { silent: true, prefix: "BN_TREND_PB" }).reason, "Before entry window (12:00 IST)", "inherits NIFTY's");
    assert.strictEqual(eng.getSignal(c, { silent: true, prefix: "SENSEX_TREND_PB" }).reason, "Before entry window (11:00 IST)", "own value wins");
  });
  withEnv({ TREND_PB_ENTRY_START: undefined, TREND_PB_ENTRY_END: undefined, BN_TREND_PB_ENTRY_START: "09:20", BN_TREND_PB_ENTRY_END: "09:50" }, () => {
    assert.ok(!/entry window/.test(eng.getSignal(c, { silent: true }).reason), "NIFTY never reads a pair key");
    assert.strictEqual(eng.getSignal(c, { silent: true, prefix: "BN_TREND_PB" }).reason, "Past entry window (09:50 IST) — no new entries");
  });
});
check("route: one builder serves every offered market; NIFTY is the default export", () => {
  const route = require("../src/routes/trendPbPaper");
  assert.strictEqual(route.forMarket("NIFTY"), route);
  assert.strictEqual(route.pairRuntime.home, true);
  const bn = route.forMarket("BANKNIFTY");
  assert.ok(bn && bn !== route && typeof bn.stopSession === "function" && typeof route.stopSession === "function");
  assert.strictEqual(bn.pairRuntime.modeKey, "bn_trend_pb");
  assert.strictEqual(route.forMarket("BANKNIFTY"), bn, "one instance per pair");
  for (const p of pairs.runnable().filter(x => x.strategyId === "trendPb")) assert.ok(route.forPair(p), p.id);
});
check("route source: market facts come from the runtime, the journal is hooked, OI stays NIFTY-only", () => {
  const src = fs.readFileSync(path.join(__dirname, "../src/routes/trendPbPaper.js"), "utf8");
  assert.ok(!/NSE:NIFTY50-INDEX/.test(src), "a spot symbol is typed in the route");
  assert.ok(!/(capitalPool|skipLogger|tradeLogger)\.\w+\("trend_pb"/.test(src), "the mode key is typed in the route");
  assert.ok(/rt\.oiApplies && oiFilter\.getOiEnabled\(MODE\)/.test(src) && /if \(rt\.oiApplies\) await oiFilter\.recordOiSample/.test(src));
  for (const h of ["onEntry", "onTick", "onStopChange", "onExit", "fields"]) assert.ok(src.includes(`tradeJournal.${h}(`), `tradeJournal.${h} not hooked`);
});
check("pair keys Settings shows reach the paper engine: ITM steps, VIX max entry; pair VIX is force-fetched", () => {
  const src = fs.readFileSync(path.join(__dirname, "../src/routes/trendPbPaper.js"), "utf8");
  assert.ok(/underlying: rt\.underlyingKey, itmSteps: PV\("ITM_STEPS"\)/.test(src), "a pair's ITM_STEPS is not passed to the symbol resolver");
  assert.ok(/fetchLiveVix\(\{ force: true \}\), sig\.signalStrength, \{ mode: "trend_pb", force: true, maxEntry: PV\("VIX_MAX_ENTRY"\) \}/.test(src),
    "a pair's VIX gate must force-fetch VIX (pair keys are unknown to anyVixEnabled) and use its own max entry");
  const vf = require("../src/services/vixFilter");
  withEnv({ TREND_PB_VIX_MAX_ENTRY: "22" }, () => {
    assert.strictEqual(vf.checkBacktestVix(18, "STRONG", { mode: "trend_pb", force: true }).allowed, true);
    assert.strictEqual(vf.checkBacktestVix(18, "STRONG", { mode: "trend_pb", force: true, maxEntry: "15" }).allowed, false);
    assert.strictEqual(vf.checkBacktestVix(18, "STRONG", { mode: "trend_pb", force: true, maxEntry: undefined }).allowed, true, "blank = the mode's level");
  });
  const isrc = fs.readFileSync(path.join(__dirname, "../src/config/instrument.js"), "utf8");
  assert.ok(/opts\.itmSteps != null && opts\.itmSteps !== "" \? String\(opts\.itmSteps\) : process\.env\[`\$\{_itmMode\}_ITM_STEPS`\]/.test(isrc));
});

// ─────────────────────────────────────────────────────────────────────────────
section("TREND DAY SCALP on every market");

const tdsOf = (mk) => pairRuntime.forStrategy("trendDayScalp", mk);
check("NIFTY is the registry's TDS: path, file, slot, sidebar, notify tag", () => {
  const rt = tdsOf("NIFTY");
  assert.deepStrictEqual(
    [rt.home, rt.modeKey, rt.envPrefix, rt.paperPath, rt.replayMode, rt.ownerId, rt.tradesFile, rt.socketSlot.mode, rt.sidebarKey, rt.historySidebarKey],
    [true, "trend_day_scalp", "TDS", "/trend-day-scalp-paper", "trend-day-scalp-paper", "trend-day-scalp-paper", "trend_day_scalp_paper_trades.json", "TREND_DAY_SCALP_PAPER", "trendDayScalpPaper", "trendDayScalpHistory"]);
});
check("other markets: own path, file, slot, prefix and instrument", () => {
  const rows = ["SENSEX", "BANKNIFTY", "NIFTY_FUT", "CRUDE"].map(mk => { const r = tdsOf(mk); return [mk, r.envPrefix, r.paperPath, r.tradesFile, r.socketSlot.mode, r.notifyMode, r.instrumentName()]; });
  assert.deepStrictEqual(rows, [
    ["SENSEX", "SENSEX_TDS", "/sensex_trend_day_scalp-paper", "sensex_trend_day_scalp_paper_trades.json", "SENSEX_TDS_PAPER", "SENSEX_TDS-PAPER", "SENSEX_OPTIONS"],
    ["BANKNIFTY", "BN_TDS", "/bn_trend_day_scalp-paper", "bn_trend_day_scalp_paper_trades.json", "BN_TDS_PAPER", "BN_TDS-PAPER", "BANKNIFTY_OPTIONS"],
    ["NIFTY_FUT", "FUT_TDS", "/fut_trend_day_scalp-paper", "fut_trend_day_scalp_paper_trades.json", "FUT_TDS_PAPER", "FUT_TDS-PAPER", "NIFTY_FUTURES"],
    ["CRUDE", "CRUDE_TDS", "/crude_trend_day_scalp-paper", "crude_trend_day_scalp_paper_trades.json", "CRUDE_TDS_PAPER", "CRUDE_TDS-PAPER", "MCX_OPTIONS"],
  ]);
  assert.strictEqual(pairs.byReplayMode("sensex_trend_day_scalp-paper").strategyId, "trendDayScalp");
  assert.strictEqual(pairs.byReplayMode("trend-day-scalp-paper"), null, "the home mode is the registry's");
});
check("engine config: NIFTY reads TDS_* exactly; a pair its own key, else NIFTY's", () => {
  const eng = require("../src/strategies/trend_day_scalp");
  withEnv({ TDS_MAX_SL_PTS: "50", TDS_GATE_TIME: "10:30", SENSEX_TDS_MAX_SL_PTS: "130", BN_TDS_MAX_SL_PTS: undefined }, () => {
    const n = eng.getConfig(), s = eng.getConfig("SENSEX_TDS"), b = eng.getConfig("BN_TDS");
    assert.deepStrictEqual([n.maxSlPts, n.gateMin], [50, 630]);
    assert.deepStrictEqual([s.maxSlPts, s.gateMin], [130, 630], "own cap, inherited gate time");
    assert.deepStrictEqual([b.maxSlPts, b.gateMin], [50, 630], "inherits NIFTY");
    assert.deepStrictEqual(eng.getConfig("TDS"), n, "the TDS prefix is NIFTY");
  });
  withEnv({ SENSEX_TDS_EMA_PERIOD: "abc" }, () => assert.strictEqual(eng.getConfig("SENSEX_TDS").emaPeriod, 20, "bad own value falls to the default"));
});
check("<PAIR>_EXPIRY_DAY_ONLY / paper switch / fill at quote follow the TDS keys", () => {
  assert.strictEqual(tdsOf("SENSEX").expiryDayOnly(), false);
  withEnv({ TDS_EXPIRY_DAY_ONLY: "true" }, () => assert.strictEqual(tdsOf("SENSEX").expiryDayOnly(), true));
  assert.strictEqual(tdsOf("BANKNIFTY").paperEnabled(), true, "TDS_PAPER_ENABLED defaults on");
  withEnv({ BN_TDS_PAPER_ENABLED: "false" }, () => assert.strictEqual(tdsOf("BANKNIFTY").paperEnabled(), false));
  assert.deepStrictEqual([tdsOf("SENSEX").fillAtQuote(), tdsOf("SENSEX").fillAtQuoteKey, tdsOf("NIFTY").fillAtQuote()], [true, "SENSEX_TDS_PAPER_FILL_AT_QUOTE", false]);
});
check("crash snapshot, logs and tags per TDS pair", () => {
  const pp = require("../src/utils/positionPersist");
  assert.strictEqual(typeof pp.saveTrendDayScalpPosition, "function", "NIFTY keeps its named snapshot");
  const tl = require("../src/utils/tradeLogger"), sl = require("../src/utils/skipLogger"), tags = require("../src/utils/logTags");
  assert.ok(tl.modes().includes("sensex_trend_day_scalp") && sl.modes().includes("fut_trend_day_scalp"));
  assert.deepStrictEqual(tags.tagsFor("bn_trend_day_scalp", {}), { market: "BANKNIFTY", strategy: "TDS" });
  assert.deepStrictEqual(tags.tagsFor("trend_day_scalp", {}), { market: "NIFTY", strategy: "TDS" });
  tdsOf("BANKNIFTY").persist.save({ side: "PE", symbol: "NSE:BANKNIFTY26NOV57900PE", entryPrice: 57800 }, { sessionPnl: 0 });
  return new Promise(r => setTimeout(r, 50)).then(() => {
    assert.strictEqual(pp.loadPairPosition("bn_trend_day_scalp").position.symbol, "NSE:BANKNIFTY26NOV57900PE");
    pp.clearPairPositions();
  });
});
check("route builder: NIFTY is the default export; one cached router per market; a pair that is off refuses /start", () => {
  const route = require("../src/routes/trendDayScalpPaper");
  assert.strictEqual(route.pairRuntime.paperPath, "/trend-day-scalp-paper");
  assert.strictEqual(typeof route.stopSession, "function");
  assert.strictEqual(route.forMarket("NIFTY"), route);
  const sx = route.forMarket("SENSEX");
  assert.ok(sx && sx !== route && route.forMarket("SENSEX") === sx, "one instance per market");
  assert.strictEqual(sx.pairRuntime.paperPath, "/sensex_trend_day_scalp-paper");
  assert.strictEqual(typeof sx.stopSession, "function");
  const express = require("express"), http = require("http");
  const app = express();
  app.use(sx.pairRuntime.paperPath, sx);
  return new Promise((resolve, reject) => {
    const srv = app.listen(0, () => {
      http.get(`http://127.0.0.1:${srv.address().port}/sensex_trend_day_scalp-paper/start`, (res) => {
        let body = "";
        res.on("data", (c) => { body += c; });
        res.on("end", () => {
          srv.close();
          try {
            assert.strictEqual(res.statusCode, 403);
            assert.ok(body.includes("SENSEX_TDS_MODE_ENABLED"), "names the pair's switch");
            assert.ok(!sx.pairRuntime.socketSlot.isActive(), "a refused start took no slot");
            resolve();
          } catch (e) { reject(e); }
        });
      }).on("error", (e) => { srv.close(); reject(e); });
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
section("HA SCALP runs as a pair");

const haOf = (mk) => pairRuntime.forStrategy("haScalp", mk);
check("NIFTY is the registry's HA SCALP: path, file, slot, sidebar", () => {
  const rt = haOf("NIFTY");
  assert.deepStrictEqual(
    [rt.home, rt.modeKey, rt.envPrefix, rt.paperPath, rt.replayMode, rt.ownerId, rt.tradesFile, rt.socketSlot.mode, rt.sidebarKey, rt.historySidebarKey],
    [true, "ha_scalp", "HA_SCALP", "/ha-scalp-paper", "ha-scalp-paper", "ha-scalp-paper", "ha_scalp_paper_trades.json", "HA_SCALP_PAPER", "haScalpPaper", "haScalpHistory"]);
});
check("HA SCALP other markets: own path, file, slot, prefix and instrument", () => {
  const rows = ["SENSEX", "BANKNIFTY", "NIFTY_FUT", "CRUDE"].map(mk => { const r = haOf(mk); return [mk, r.envPrefix, r.paperPath, r.tradesFile, r.socketSlot.mode, r.notifyMode, r.instrumentName()]; });
  assert.deepStrictEqual(rows, [
    ["SENSEX", "SENSEX_HA_SCALP", "/sensex_ha_scalp-paper", "sensex_ha_scalp_paper_trades.json", "SENSEX_HA_SCALP_PAPER", "SENSEX_HA_SCALP-PAPER", "SENSEX_OPTIONS"],
    ["BANKNIFTY", "BN_HA_SCALP", "/bn_ha_scalp-paper", "bn_ha_scalp_paper_trades.json", "BN_HA_SCALP_PAPER", "BN_HA_SCALP-PAPER", "BANKNIFTY_OPTIONS"],
    ["NIFTY_FUT", "FUT_HA_SCALP", "/fut_ha_scalp-paper", "fut_ha_scalp_paper_trades.json", "FUT_HA_SCALP_PAPER", "FUT_HA_SCALP-PAPER", "NIFTY_FUTURES"],
    ["CRUDE", "CRUDE_HA_SCALP", "/crude_ha_scalp-paper", "crude_ha_scalp_paper_trades.json", "CRUDE_HA_SCALP_PAPER", "CRUDE_HA_SCALP-PAPER", "MCX_OPTIONS"],
  ]);
  assert.strictEqual(pairs.byReplayMode("sensex_ha_scalp-paper").strategyId, "haScalp");
  assert.strictEqual(pairs.byReplayMode("ha-scalp-paper"), null, "the home mode is the registry's");
});
check("HA SCALP engine config: NIFTY reads HA_SCALP_* exactly; a pair its own key, else NIFTY's", () => {
  const eng = require("../src/strategies/ha_scalp");
  withEnv({ HA_SCALP_MIN_BODY_PTS: "7", HA_SCALP_MA_TYPE: "ema", HA_SCALP_ENTRY_END: "14:00", SENSEX_HA_SCALP_MIN_BODY_PTS: "20", SENSEX_HA_SCALP_MAX_MA_DIST_PTS: "500", BN_HA_SCALP_MIN_BODY_PTS: undefined }, () => {
    const n = eng.getConfig(), s = eng.getConfig("SENSEX_HA_SCALP"), b = eng.getConfig("BN_HA_SCALP");
    assert.deepStrictEqual([n.minBodyPts, n.maType, n.entryEndMin, n.maxMaDistPts], [7, "ema", 840, 150]);
    assert.deepStrictEqual([s.minBodyPts, s.maType, s.entryEndMin, s.maxMaDistPts], [20, "ema", 840, 500], "own body / MA distance, inherited MA type and window");
    assert.deepStrictEqual([b.minBodyPts, b.maxMaDistPts], [7, 150], "inherits NIFTY");
    assert.deepStrictEqual(eng.getConfig("HA_SCALP"), n, "the HA_SCALP prefix is NIFTY");
  });
  withEnv({ SENSEX_HA_SCALP_MA_PERIOD: "abc" }, () => assert.strictEqual(eng.getConfig("SENSEX_HA_SCALP").maPeriod, 50, "bad own value falls to the default"));
});
check("HA SCALP <PAIR>_EXPIRY_DAY_ONLY / paper switch / fill at quote follow the HA_SCALP keys", () => {
  assert.strictEqual(haOf("SENSEX").expiryDayOnly(), false);
  withEnv({ HA_SCALP_EXPIRY_DAY_ONLY: "true" }, () => assert.strictEqual(haOf("SENSEX").expiryDayOnly(), true));
  assert.strictEqual(haOf("BANKNIFTY").paperEnabled(), true, "HA_SCALP_PAPER_ENABLED defaults on");
  withEnv({ BN_HA_SCALP_PAPER_ENABLED: "false" }, () => assert.strictEqual(haOf("BANKNIFTY").paperEnabled(), false));
  assert.deepStrictEqual([haOf("SENSEX").fillAtQuote(), haOf("SENSEX").fillAtQuoteKey, haOf("NIFTY").fillAtQuote()], [true, "SENSEX_HA_SCALP_PAPER_FILL_AT_QUOTE", false]);
});
check("HA SCALP crash snapshot, logs and tags per pair; capital on the Fyers pool", () => {
  const pp = require("../src/utils/positionPersist");
  assert.strictEqual(typeof pp.saveHaScalpPosition, "function", "NIFTY keeps its named snapshot");
  const tl = require("../src/utils/tradeLogger"), sl = require("../src/utils/skipLogger"), tags = require("../src/utils/logTags");
  assert.ok(tl.modes().includes("sensex_ha_scalp") && sl.modes().includes("fut_ha_scalp"));
  assert.deepStrictEqual(tags.tagsFor("bn_ha_scalp", {}), { market: "BANKNIFTY", strategy: "HA_SCALP" });
  assert.deepStrictEqual(tags.tagsFor("ha_scalp", {}), { market: "NIFTY", strategy: "HA_SCALP" });
  assert.strictEqual(pairs.get("haScalp", "SENSEX").broker, "fyers");
  assert.strictEqual(pairs.get("haScalp", "NIFTY").broker, "zerodha", "NIFTY keeps its Zerodha book");
  haOf("BANKNIFTY").persist.save({ side: "CE", symbol: "NSE:BANKNIFTY26NOV57700CE", entryPrice: 57800 }, { sessionPnl: 0 });
  return new Promise(r => setTimeout(r, 50)).then(() => {
    assert.strictEqual(pp.loadPairPosition("bn_ha_scalp").position.symbol, "NSE:BANKNIFTY26NOV57700CE");
    pp.clearPairPositions();
  });
});
check("HA SCALP route builder: NIFTY is the default export; one cached router per market; a pair that is off refuses /start", () => {
  const route = require("../src/routes/haScalpPaper");
  assert.strictEqual(route.pairRuntime.paperPath, "/ha-scalp-paper");
  assert.strictEqual(typeof route.stopSession, "function");
  assert.strictEqual(typeof route.attributeQuotes, "function", "the quote attribution stays exported");
  assert.strictEqual(route.forMarket("NIFTY"), route);
  const sx = route.forMarket("SENSEX");
  assert.ok(sx && sx !== route && route.forMarket("SENSEX") === sx, "one instance per market");
  assert.strictEqual(sx.pairRuntime.paperPath, "/sensex_ha_scalp-paper");
  assert.strictEqual(typeof sx.stopSession, "function");
  assert.ok(route.forMarket("CRUDE") && route.forMarket("CRUDE") !== sx, "MCX is offered (no 09:15 index open needed)");
  const express = require("express"), http = require("http");
  const app = express();
  app.use(sx.pairRuntime.paperPath, sx);
  app.use(route.pairRuntime.paperPath, route);
  const get = (port, p) => new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}${p}`, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => resolve({ code: res.statusCode, body }));
    }).on("error", reject);
  });
  return new Promise((resolve, reject) => {
    const srv = app.listen(0, async () => {
      const port = srv.address().port;
      try {
        const r = await get(port, "/sensex_ha_scalp-paper/start");
        assert.strictEqual(r.code, 403);
        assert.ok(r.body.includes("SENSEX_HA_SCALP_MODE_ENABLED"), "names the pair's switch");
        assert.ok(!sx.pairRuntime.socketSlot.isActive(), "a refused start took no slot");
        const a = JSON.parse((await get(port, "/sensex_ha_scalp-paper/status/data")).body);
        const b = JSON.parse((await get(port, "/ha-scalp-paper/status/data")).body);
        assert.strictEqual(a.spotSymbol, "BSE:SENSEX-INDEX", "the SENSEX instance reads the SENSEX index");
        assert.strictEqual(b.spotSymbol, "NSE:NIFTY50-INDEX");
        assert.strictEqual(a.running, false);
        srv.close();
        resolve();
      } catch (e) { srv.close(); reject(e); }
    });
  });
});

section("RSI PIVOT ST runs as a pair (routes/rsiPivotStPaper.js)");

const rpsOf = (mk) => pairRuntime.forStrategy("rsiPivotSt", mk);
check("NIFTY is the registry's RSI PIVOT ST: path, file, slot, sidebar, notify tag", () => {
  const rt = rpsOf("NIFTY");
  assert.deepStrictEqual(
    [rt.home, rt.modeKey, rt.envPrefix, rt.paperPath, rt.replayMode, rt.ownerId, rt.tradesFile, rt.socketSlot.mode, rt.notifyMode, rt.sidebarKey, rt.historySidebarKey],
    [true, "rsi_pivot_st", "RSI_PIVOT_ST", "/rsi-pivot-st-paper", "rsi-pivot-st-paper", "rsi-pivot-st-paper", "rsi_pivot_st_paper_trades.json", "RSI_PIVOT_ST_PAPER", "RSI_PIVOT_ST-PAPER", "rsiPivotStPaper", "rsiPivotStHistory"]);
});
check("BANKNIFTY keeps the retired BN_PIVOT_RSI_ST copy's path, file, keys and slot", () => {
  const bn = rpsOf("BANKNIFTY");
  assert.deepStrictEqual(
    [bn.envPrefix, bn.modeKey, bn.paperPath, bn.replayMode, bn.tradesFile, bn.socketSlot.mode, bn.notifyMode, bn.pair.enabledKey, bn.instrumentName()],
    ["BN_PIVOT_RSI_ST", "bn_pivot_rsi_st", "/bn-pivot-rsi-st-paper", "bn-pivot-rsi-st-paper", "bn_pivot_rsi_st_paper_trades.json", "BN_PIVOT_RSI_ST_PAPER", "BN_PIVOT_RSI_ST-PAPER", "BN_PIVOT_RSI_ST_MODE_ENABLED", "BANKNIFTY_OPTIONS"]);
  assert.strictEqual(pairs.byReplayMode("bn-pivot-rsi-st-paper").id, "rsiPivotSt@BANKNIFTY");
  assert.strictEqual(pairs.byModeKey("bn_pivot_rsi_st").marketKey, "BANKNIFTY");
  assert.strictEqual(pairs.pairKey(bn.pair, "RSI_PIVOT_ST_RSI_CE_MIN"), "BN_PIVOT_RSI_ST_RSI_CE_MIN");
  const rows = ["SENSEX", "NIFTY_FUT", "CRUDE"].map(mk => { const r = rpsOf(mk); return [mk, r.envPrefix, r.paperPath, r.tradesFile, r.socketSlot.mode, r.instrumentName()]; });
  assert.deepStrictEqual(rows, [
    ["SENSEX", "SENSEX_RSI_PIVOT_ST", "/sensex_rsi_pivot_st-paper", "sensex_rsi_pivot_st_paper_trades.json", "SENSEX_RSI_PIVOT_ST_PAPER", "SENSEX_OPTIONS"],
    ["NIFTY_FUT", "FUT_RSI_PIVOT_ST", "/fut_rsi_pivot_st-paper", "fut_rsi_pivot_st_paper_trades.json", "FUT_RSI_PIVOT_ST_PAPER", "NIFTY_FUTURES"],
    ["CRUDE", "CRUDE_RSI_PIVOT_ST", "/crude_rsi_pivot_st-paper", "crude_rsi_pivot_st_paper_trades.json", "CRUDE_RSI_PIVOT_ST_PAPER", "MCX_OPTIONS"],
  ]);
  assert.strictEqual(pairs.byReplayMode("rsi-pivot-st-paper"), null, "the home mode is the registry's");
});
check("engine config: NIFTY reads RSI_PIVOT_ST_* exactly; a pair its own key, else NIFTY's; strikes on its own grid", () => {
  const eng = require("../src/strategies/rsi_pivot_st");
  withEnv({ RSI_PIVOT_ST_RSI_CE_MIN: "65", RSI_PIVOT_ST_STRIKE_MODE: "ITM", SENSEX_RSI_PIVOT_ST_RSI_CE_MIN: "72", BN_PIVOT_RSI_ST_RSI_CE_MIN: undefined }, () => {
    const n = eng.getConfig(), s = eng.getConfig("SENSEX_RSI_PIVOT_ST"), b = eng.getConfig("BN_PIVOT_RSI_ST");
    assert.deepStrictEqual([n.rsiCeMin, n.strikeMode], [65, "ITM"]);
    assert.deepStrictEqual([s.rsiCeMin, s.strikeMode], [72, "ITM"], "own threshold, inherited strike mode");
    assert.deepStrictEqual([b.rsiCeMin, b.strikeMode], [65, "ITM"], "inherits NIFTY");
    assert.deepStrictEqual(eng.getConfig("RSI_PIVOT_ST"), n, "the RSI_PIVOT_ST prefix is NIFTY");
  });
  withEnv({ SENSEX_RSI_PIVOT_ST_RSI_PERIOD: "abc" }, () => assert.strictEqual(eng.getConfig("SENSEX_RSI_PIVOT_ST").rsiPeriod, 14, "bad own value falls to the default"));
  const cfg = Object.assign(eng.getConfig(), { strikeMode: "OTM", strikePct: 1 });
  assert.deepStrictEqual(eng.strikeForSide(24012, "CE", cfg), { strike: 24250, steps: 5, mode: "OTM", atm: 24000, distancePts: 238 }, "NIFTY: 50-pt grid");
  assert.strictEqual(eng.strikeForSide(57040, "PE", Object.assign({}, cfg, { strikeStep: 100 })).strike, 56400, "BANKNIFTY: 100-pt grid, 6 strikes out");
});
check("<PAIR>_EXPIRY_DAY_ONLY / paper switch / fill at quote follow the RSI_PIVOT_ST keys", () => {
  assert.strictEqual(rpsOf("SENSEX").expiryDayOnly(), false);
  withEnv({ RSI_PIVOT_ST_EXPIRY_DAY_ONLY: "true" }, () => assert.strictEqual(rpsOf("SENSEX").expiryDayOnly(), true));
  withEnv({ RSI_PIVOT_ST_EXPIRY_DAY_ONLY: "true", BN_PIVOT_RSI_ST_EXPIRY_DAY_ONLY: "false" }, () => assert.strictEqual(rpsOf("BANKNIFTY").expiryDayOnly(), false));
  assert.strictEqual(rpsOf("BANKNIFTY").paperEnabled(), true, "RSI_PIVOT_ST_PAPER_ENABLED defaults on");
  withEnv({ BN_PIVOT_RSI_ST_PAPER_ENABLED: "false" }, () => assert.strictEqual(rpsOf("BANKNIFTY").paperEnabled(), false));
  assert.deepStrictEqual([rpsOf("SENSEX").fillAtQuote(), rpsOf("BANKNIFTY").fillAtQuoteKey, rpsOf("NIFTY").fillAtQuote()], [true, "BN_PIVOT_RSI_ST_PAPER_FILL_AT_QUOTE", false]);
});
check("crash snapshot and logs per RSI PIVOT ST pair", () => {
  const pp = require("../src/utils/positionPersist");
  assert.strictEqual(typeof pp.saveRsiPivotStPosition, "function", "NIFTY keeps its named snapshot");
  const tl = require("../src/utils/tradeLogger"), sl = require("../src/utils/skipLogger");
  assert.ok(tl.modes().includes("bn_pivot_rsi_st") && sl.modes().includes("sensex_rsi_pivot_st"));
  rpsOf("BANKNIFTY").persist.save({ side: "CE", symbol: "NSE:BANKNIFTY26NOV58400CE", entryPrice: 57800 }, { sessionPnl: 0 });
  return new Promise(r => setTimeout(r, 50)).then(() => {
    assert.strictEqual(pp.loadPairPosition("bn_pivot_rsi_st").position.symbol, "NSE:BANKNIFTY26NOV58400CE");
    pp.clearPairPositions();
  });
});
check("route builder: NIFTY is the default export; one cached router per market; a pair that is off refuses /start", () => {
  const route = require("../src/routes/rsiPivotStPaper");
  assert.strictEqual(route.pairRuntime.paperPath, "/rsi-pivot-st-paper");
  assert.strictEqual(typeof route.stopSession, "function");
  assert.strictEqual(route.forMarket("NIFTY"), route);
  const bn = route.forMarket("BANKNIFTY");
  assert.ok(bn && bn !== route && route.forMarket("BANKNIFTY") === bn, "one instance per market");
  assert.ok(route.forMarket("SENSEX") !== bn, "markets never share an instance");
  assert.strictEqual(bn.pairRuntime.paperPath, "/bn-pivot-rsi-st-paper");
  const code = fs.readFileSync(path.join(__dirname, "../src/routes/rsiPivotStPaper.js"), "utf8");
  assert.ok(/const ROUTE\s*=\s*rt\.paperPath;/.test(code) && /const MODE\s*=\s*rt\.modeKey;/.test(code), "path / mode key must come from rt");
  const express = require("express"), http = require("http");
  const app = express();
  app.use(bn.pairRuntime.paperPath, bn);
  return new Promise((resolve, reject) => {
    const srv = app.listen(0, () => {
      http.get(`http://127.0.0.1:${srv.address().port}/bn-pivot-rsi-st-paper/start`, (res) => {
        let body = "";
        res.on("data", (c) => { body += c; });
        res.on("end", () => {
          srv.close();
          try {
            assert.strictEqual(res.statusCode, 403);
            assert.ok(body.includes("BN_PIVOT_RSI_ST_MODE_ENABLED"), "names the pair's switch");
            assert.ok(!bn.pairRuntime.socketSlot.isActive(), "a refused start took no slot");
            resolve();
          } catch (e) { reject(e); }
        });
      }).on("error", (e) => { srv.close(); reject(e); });
    });
  });
});

section("PIVOT_EMA_ST runs as a pair (routes/pivotEmaStPaper.js)");

const pesOf = (mk) => pairRuntime.forStrategy("pivotEmaSt", mk);
check("NIFTY is the registry's PIVOT_EMA_ST: path, file, slot, sidebar, notify tag", () => {
  const rt = pesOf("NIFTY");
  assert.deepStrictEqual(
    [rt.home, rt.modeKey, rt.envPrefix, rt.paperPath, rt.replayMode, rt.ownerId, rt.tradesFile, rt.socketSlot.mode, rt.sidebarKey, rt.historySidebarKey, rt.notifyMode],
    [true, "pivot_ema_st", "PIVOT_EMA_ST", "/pivot_ema_st-paper", "pivot_ema_st-paper", "pivot_ema_st-paper", "pivot_ema_st_paper_trades.json", "PIVOT_EMA_ST_PAPER", "pivotEmaStPaper", "pivotEmaStHistory", "PIVOT_EMA_ST-PAPER"]);
});
check("BN / SAIL / FUT keep the old twins' paths, keys and files; SENSEX / MCX get their own", () => {
  const rows = ["BANKNIFTY", "SAIL", "NIFTY_FUT", "SENSEX", "CRUDE"].map(mk => { const r = pesOf(mk); return [mk, r.envPrefix, r.paperPath, r.tradesFile, r.socketSlot.mode, r.instrumentName()]; });
  assert.deepStrictEqual(rows, [
    ["BANKNIFTY", "BN_PIVOT_EMA_ST", "/bn_pivot_ema_st-paper", "bn_pivot_ema_st_paper_trades.json", "BN_PIVOT_EMA_ST_PAPER", "BANKNIFTY_OPTIONS"],
    ["SAIL", "SAIL_PIVOT_EMA_ST", "/sail_pivot_ema_st-paper", "sail_pivot_ema_st_paper_trades.json", "SAIL_PIVOT_EMA_ST_PAPER", "SAIL_OPTIONS"],
    ["NIFTY_FUT", "FUT_PIVOT_EMA_ST", "/fut_pivot_ema_st-paper", "fut_pivot_ema_st_paper_trades.json", "FUT_PIVOT_EMA_ST_PAPER", "NIFTY_FUTURES"],
    ["SENSEX", "SENSEX_PIVOT_EMA_ST", "/sensex_pivot_ema_st-paper", "sensex_pivot_ema_st_paper_trades.json", "SENSEX_PIVOT_EMA_ST_PAPER", "SENSEX_OPTIONS"],
    ["CRUDE", "CRUDE_PIVOT_EMA_ST", "/crude_pivot_ema_st-paper", "crude_pivot_ema_st_paper_trades.json", "CRUDE_PIVOT_EMA_ST_PAPER", "MCX_OPTIONS"],
  ]);
  assert.strictEqual(pairs.byReplayMode("bn_pivot_ema_st-paper").strategyId, "pivotEmaSt");
  assert.strictEqual(pairs.byReplayMode("pivot_ema_st-paper"), null, "the home mode is the registry's");
});
check("engine config: NIFTY reads PIVOT_EMA_ST_* exactly; a pair its own key, else NIFTY's", () => {
  const eng = require("../src/strategies/pivot_ema_st");
  withEnv({ PIVOT_EMA_ST_TF: "5", PIVOT_EMA_ST_EMA_FAST: "21", BN_PIVOT_EMA_ST_TF: "15", BN_PIVOT_EMA_ST_EMA_FAST: undefined, SENSEX_PIVOT_EMA_ST_TF: undefined, SENSEX_PIVOT_EMA_ST_EMA_FAST: undefined }, () => {
    const n = eng.getConfig("PIVOT_EMA_ST"), b = eng.getConfig("BN_PIVOT_EMA_ST"), s = eng.getConfig("SENSEX_PIVOT_EMA_ST");
    assert.deepStrictEqual([n.TF, n.EMA_FAST], [5, 21]);
    assert.deepStrictEqual([b.TF, b.EMA_FAST], [15, 21], "own TF, inherited EMA");
    assert.deepStrictEqual([s.TF, s.EMA_FAST], [5, 21], "inherits NIFTY");
    assert.strictEqual(eng.warmupDays("BN_PIVOT_EMA_ST"), 11, "warm-up follows the pair's own TF");
  });
  withEnv({ SENSEX_PIVOT_EMA_ST_ST_MULT: "abc", PIVOT_EMA_ST_ST_MULT: undefined }, () => assert.strictEqual(eng.getConfig("SENSEX_PIVOT_EMA_ST").ST_MULT, 3, "bad own value falls to the default"));
});
check("crash snapshot, logs and tags per PIVOT_EMA_ST pair", () => {
  const pp = require("../src/utils/positionPersist");
  assert.strictEqual(typeof pp.savePivotEmaStPosition, "function", "NIFTY keeps its named snapshot");
  const tl = require("../src/utils/tradeLogger"), sl = require("../src/utils/skipLogger");
  assert.ok(tl.modes().includes("sensex_pivot_ema_st") && sl.modes().includes("fut_pivot_ema_st"));
  pesOf("SENSEX").persist.save({ side: "CE", symbol: "BSE:SENSEX26N1981000CE", entryPrice: 80950 }, { sessionPnl: 0 });
  return new Promise(r => setTimeout(r, 50)).then(() => {
    assert.strictEqual(pp.loadPairPosition("sensex_pivot_ema_st").position.symbol, "BSE:SENSEX26N1981000CE");
    pp.clearPairPositions();
  });
});
check("route builder: NIFTY is the default export; one cached router per market; a pair that is off refuses /start", () => {
  const route = require("../src/routes/pivotEmaStPaper");
  assert.strictEqual(route.pairRuntime.paperPath, "/pivot_ema_st-paper");
  assert.strictEqual(typeof route.stopSession, "function");
  assert.strictEqual(route.forMarket("NIFTY"), route);
  const bn = route.forMarket("BANKNIFTY");
  assert.ok(bn && bn !== route && route.forMarket("BANKNIFTY") === bn, "one instance per market");
  assert.strictEqual(bn.pairRuntime.paperPath, "/bn_pivot_ema_st-paper");
  assert.strictEqual(typeof bn.stopSession, "function");
  const express = require("express"), http = require("http");
  const app = express();
  app.use(bn.pairRuntime.paperPath, bn);
  return new Promise((resolve, reject) => {
    const srv = app.listen(0, () => {
      http.get(`http://127.0.0.1:${srv.address().port}/bn_pivot_ema_st-paper/start`, (res) => {
        let body = "";
        res.on("data", (c) => { body += c; });
        res.on("end", () => {
          srv.close();
          try {
            assert.strictEqual(res.statusCode, 403);
            assert.ok(body.includes("BN_PIVOT_EMA_ST_MODE_ENABLED"), "names the pair's switch");
            assert.ok(!bn.pairRuntime.socketSlot.isActive(), "a refused start took no slot");
            resolve();
          } catch (e) { reject(e); }
        });
      }).on("error", (e) => { srv.close(); reject(e); });
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Async checks above return promises; wait for them before reporting.
(async () => {
  await _runChecks();
  console.log(`\n${fail ? "❌" : "✅"} pairRuntime: ${pass} passed, ${fail} failed`);
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (_) {}
  process.exit(fail ? 1 : 0);
})();

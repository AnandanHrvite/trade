#!/usr/bin/env node
/**
 * INSTRUMENT-MODE INVARIANTS — options by default, futures only by NAME
 *
 *   node tests/instrumentMode.regression.js
 *
 * Zero dependencies, zero framework, exits non-zero on failure. Nothing here opens
 * a socket, a broker connection or a session.
 *
 * The model this suite defends (2026-11): there is NO global instrument toggle.
 * `INSTRUMENT` used to be one Settings switch that flipped every strategy between
 * NIFTY options and NIFTY futures; it was honoured by only some strategies and the
 * rest silently kept buying options. It has been REMOVED:
 *
 *   - every strategy trades NIFTY options, always — config/instrument.js
 *     getInstrument() no longer reads process.env, so a stale
 *     `INSTRUMENT=NIFTY_FUTURES` left in an .env is IGNORED;
 *   - futures trade only through the FUT_* twin strategies (fut*Paper.js /
 *     fut*Backtest.js), which ask for futures EXPLICITLY on every call — a literal
 *     "NIFTY_FUTURES" argument to getSymbol / getSymbolSync / getLotQty, or the
 *     pinned `instrumentMode.futures` binding.
 *
 * GROUPS 9–11 DISCOVER the routes from disk rather than listing them. A futures
 * twin added later is enrolled the moment its fut*Paper.js file exists and must
 * prove it forces futures; every other route must prove it cannot reach futures
 * through any path the removed toggle used to open.
 *
 * Exemption sets are kept, re-expressed: the strategies they name (premium-
 * denominated, MCX, stock options, cash equity, options-by-rule) are the ones
 * that must never get a NIFTY futures twin — asserted in the last group.
 */

const assert = require("assert");
const fs     = require("fs");
const path   = require("path");

const SRC    = path.join(__dirname, "../src");
const ROUTES = path.join(SRC, "routes");
const read   = (rel) => fs.readFileSync(path.join(SRC, rel), "utf-8");
// Prose that merely mentions code is not code — assertions run on decommented text
// so a comment saying "NIFTY_FUTURES" cannot satisfy a wiring assertion.
const decomment = (s) => s.split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
// Stricter: also drops inline `/* … */` and trailing ` // …` comments on code lines.
// (A URL keeps its `://` — the trailing form needs whitespace before the slashes.)
const codeOf = (s) => decomment(s).split("\n")
  .map(l => l.replace(/\/\*.*?\*\//g, "").replace(/(^|\s)\/\/\s.*$/, "$1"))
  .join("\n");

// Async-aware runner: a check may return a promise (resolveEntryInstrument is
// async). Cases are queued and awaited in order, so a rejected promise is a ❌,
// never a silent ✅ — the previous synchronous runner passed an async check the
// moment its promise was created.
let pass = 0, fail = 0;
const _queue = [];
function section(t) { _queue.push({ section: t }); }
function check(name, fn) { _queue.push({ name, fn }); }

const instrumentMode = require("../src/utils/instrumentMode");
const instrument     = require("../src/config/instrument");
const { calcCharges } = require("../src/utils/charges");

/** Run fn with process.env[k] set (or deleted when v is undefined), then restore. */
function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k];
  }
  const restore = () => {
    for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  };
  try {
    const r = fn();
    if (r && typeof r.then === "function") return r.finally(restore);
    restore();
    return r;
  } catch (e) { restore(); throw e; }
}

/**
 * Every call `name(…)` in src, with its argument text (balanced parens). Skips
 * declarations (`function name(`) — only call sites are returned.
 */
function callsOf(src, name) {
  const out = [];
  const re = new RegExp(`(?<![A-Za-z0-9_$])${name}\\(`, "g");
  let m;
  while ((m = re.exec(src))) {
    const before = src.slice(Math.max(0, m.index - 10), m.index);
    if (/function\s+$/.test(before)) continue;
    let depth = 1, i = m.index + m[0].length;
    for (; i < src.length && depth > 0; i++) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")") depth--;
    }
    out.push(src.slice(m.index + m[0].length, i - 1));
  }
  return out;
}
/** Every `const|let|var NAME = <rhs>` binding of the given name pattern. */
function bindingsOf(src, namePattern) {
  const out = [];
  const re = new RegExp(`\\b(?:const|let|var)\\s+(${namePattern})\\s*=\\s*([^;\\n]+)`, "g");
  let m;
  while ((m = re.exec(src))) out.push({ name: m[1], rhs: m[2].trim() });
  return out;
}

const FUT_LIT = /["']NIFTY_FUTURES["']/;

// ── Strategies that can never have a NIFTY futures twin ─────────────────────
// They used to be EXEMPT from the global toggle; with the toggle gone they are
// options-only like everything else, and what remains true is that a futures
// version of them would be meaningless — asserted in the last group.
//
// Premium-denominated: the trigger, stop and trail are all option-premium levels.
const PREMIUM_DENOMINATED = new Set(["simple930Paper.js", "itm20ScalpPaper.js", "itm20ScalpBacktest.js"]);
// COMMODITY (MCX) pages — they never trade NIFTY at all.
const NOT_NIFTY = { has: (f) => /^cmx[A-Z][A-Za-z0-9]*Paper\.js$/.test(f) };
// STOCK-option strategies — every contract names its own stock underlying.
const STOCK_OPTIONS = { SAIL: new Set(["sailVwapStPaper.js", "sailVwapStBacktest.js", "sailPivotEmaStPaper.js"]) };
const stockUnderlyingOf = (f) => Object.keys(STOCK_OPTIONS).find((k) => STOCK_OPTIONS[k].has(f)) || null;
// GAP_RUNAWAY: by the user's rule NO common setting applies to it — it always
// buys the exact-ATM NIFTY option.
const OPTIONS_ONLY_BY_RULE = new Set(["gapRunawayPaper.js"]);
// Its stock scanner trades CASH EQUITY (intraday shares) — no NIFTY contract.
const CASH_EQUITY_ONLY = new Set(["gapRunawayStkPaper.js"]);

const NEVER_A_FUTURES_TWIN = (f) =>
  PREMIUM_DENOMINATED.has(f) || NOT_NIFTY.has(f) || !!stockUnderlyingOf(f) ||
  OPTIONS_ONLY_BY_RULE.has(f) || CASH_EQUITY_ONLY.has(f);

// ─────────────────────────────────────────────────────────────────────────────
section("The global INSTRUMENT env is IGNORED — every default reader says options");

const FUT_ENV_SPELLINGS = ["NIFTY_FUTURES", " nifty_futures ", "nifty_futures", "NIFTY_FUTURES "];

check("instrumentConfig.INSTRUMENT is NIFTY_OPTIONS whatever INSTRUMENT says", () => {
  for (const v of [...FUT_ENV_SPELLINGS, "NIFTY_OPTIONS", "", "garbage", undefined]) {
    withEnv({ INSTRUMENT: v }, () => {
      assert.strictEqual(instrument.INSTRUMENT, "NIFTY_OPTIONS",
        `INSTRUMENT=${JSON.stringify(v)} switched the global instrument to ${instrument.INSTRUMENT} — the toggle was removed`);
    });
  }
});

check("the default instrumentMode export IS the options binding", () => {
  for (const fn of ["isFutures", "instrumentLabel", "directionFor", "resolveEntryInstrument",
                    "premiumGatesApply", "computePnl", "unrealisedPnl", "capitalRequired"]) {
    assert.strictEqual(typeof instrumentMode[fn], "function", `instrumentMode.${fn} is missing`);
    assert.strictEqual(instrumentMode[fn], instrumentMode.options[fn],
      `instrumentMode.${fn} is not the options binding's — a bare require must never be able to trade futures`);
    assert.notStrictEqual(instrumentMode[fn], instrumentMode.futures[fn], `instrumentMode.${fn} is the futures binding's`);
  }
});

check("with INSTRUMENT=NIFTY_FUTURES the default binding still prices a BOUGHT option", () => {
  withEnv({ INSTRUMENT: "NIFTY_FUTURES" }, () => {
    assert.strictEqual(instrumentMode.isFutures(), false);
    assert.strictEqual(instrumentMode.instrumentLabel(), "options");
    assert.strictEqual(instrumentMode.premiumGatesApply(), true, "premium gates must keep running for options");
    assert.strictEqual(instrumentMode.directionFor("PE"), +1, "a bought PE gains as its premium rises");
    const r = instrumentMode.computePnl({ side: "PE", entrySpot: 24000, exitSpot: 23900,
      entryPremium: 100, exitPremium: 150, qty: 65, broker: "fyers" });
    assert.strictEqual(r.isFutures, false);
    assert.strictEqual(r.gross, 3250, "options P&L is the premium move × qty (50 × 65)");
    assert.strictEqual(instrumentMode.capitalRequired(65, 200), 13000, "options capital is the premium outlay");
  });
});

check("with INSTRUMENT=NIFTY_FUTURES a symbol asked for WITHOUT an instrument is an OPTION", () => {
  withEnv({ INSTRUMENT: "NIFTY_FUTURES" }, () => {
    for (const side of ["CE", "PE"]) {
      const sym = instrument.getSymbolSync(side);
      assert.ok(new RegExp(`^NSE:NIFTY\\w+\\d${side}$`).test(sym), `getSymbolSync("${side}") gave "${sym}" — expected an option`);
      assert.ok(!/FUT$/.test(sym), `getSymbolSync("${side}") resolved a FUTURES contract from the removed toggle`);
    }
    const lot = withEnv({ INSTRUMENT: undefined }, () => instrument.getLotQty());
    assert.strictEqual(instrument.getLotQty(), lot, "the env toggle must not change the default lot size");
  });
});

check("resolveInstrument: only an EXPLICIT futures argument selects futures", () => {
  withEnv({ INSTRUMENT: "NIFTY_FUTURES" }, () => {
    assert.strictEqual(instrument.resolveInstrument(undefined), "NIFTY_OPTIONS", "no argument → the global (options), never the env");
    assert.strictEqual(instrument.resolveInstrument(""), "NIFTY_OPTIONS");
    for (const v of ["garbage", "FUTURES", "NIFTY"]) {
      assert.strictEqual(instrument.resolveInstrument(v), "NIFTY_OPTIONS", `${JSON.stringify(v)} must fall back to options`);
    }
    for (const v of ["NIFTY_FUTURES", " nifty_futures "]) {
      assert.strictEqual(instrument.resolveInstrument(v), "NIFTY_FUTURES", `${JSON.stringify(v)} is a futures request`);
    }
  });
});

check("forInstrument picks the pinned binding; anything unrecognised is options", () => {
  assert.strictEqual(instrumentMode.forInstrument("NIFTY_FUTURES"), instrumentMode.futures);
  assert.strictEqual(instrumentMode.forInstrument(" nifty_futures "), instrumentMode.futures);
  for (const v of [undefined, "", "NIFTY_OPTIONS", "garbage", "FUTURES"]) {
    assert.strictEqual(instrumentMode.forInstrument(v), instrumentMode.options, `forInstrument(${JSON.stringify(v)}) must be options`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
section("instrumentMode.futures — direction, P&L and charge rates (pinned, env-independent)");

const fut = instrumentMode.futures;

check("the futures binding is futures whatever INSTRUMENT says", () => {
  for (const v of [undefined, "NIFTY_OPTIONS", "garbage", "NIFTY_FUTURES"]) {
    withEnv({ INSTRUMENT: v }, () => {
      assert.strictEqual(fut.isFutures(), true, `INSTRUMENT=${JSON.stringify(v)} turned the futures binding off`);
      assert.strictEqual(fut.instrumentLabel(), "futures");
      assert.strictEqual(fut.premiumGatesApply(), false, "there is no premium to gate on a future");
    });
  }
});

check("a PE is a SHORT and a CE a LONG on the futures binding", () => {
  assert.strictEqual(fut.directionFor("PE"), -1, "PE must be SHORT in futures");
  assert.strictEqual(fut.directionFor("CE"), +1, "CE must be LONG in futures");
  assert.strictEqual(instrumentMode.forInstrument("NIFTY_FUTURES").directionFor("PE"), -1);
});

check("a futures PE PROFITS when NIFTY falls (the sign bug this prevents)", () => {
  const r = fut.computePnl({ side: "PE", entrySpot: 24000, exitSpot: 23900, qty: 65, broker: "fyers" });
  assert.ok(r.gross > 0, `a 100pt fall on a short must be a GAIN, got gross ${r.gross}`);
  assert.strictEqual(r.gross, 6500, "100pt × 65 = ₹6,500");
  assert.ok(/SHORT/.test(r.pnlMode), `pnlMode must record the direction, got "${r.pnlMode}"`);
});

check("futures P&L is index points × qty, NOT a premium difference", () => {
  const r = fut.computePnl({
    side: "CE", entrySpot: 24000, exitSpot: 24100,
    // Premium args must be IGNORED on the futures binding — passing them is how a
    // half-converted call site would otherwise silently keep option maths.
    entryPremium: 200, exitPremium: 100,
    qty: 65, broker: "fyers",
  });
  assert.strictEqual(r.gross, 6500, "must price the SPOT move, not the premium args");
  assert.strictEqual(r.isFutures, true);
});

check("futures are billed at FUTURES statutory rates, not option rates", () => {
  const opt = calcCharges({ isFutures: false, entryPremium: 24000, exitPremium: 24100, qty: 65 });
  const fu  = calcCharges({ isFutures: true,  entryPremium: 24000, exitPremium: 24100, qty: 65 });
  assert.ok(fu.stt < opt.stt, `futures STT (${fu.stt}) must be below options STT (${opt.stt})`);
  assert.ok(fu.total !== opt.total, "futures and options cannot bill identically");
  const r = fut.computePnl({ side: "CE", entrySpot: 24000, exitSpot: 24100, qty: 65, broker: "fyers" });
  const { getCharges } = require("../src/utils/charges");
  assert.strictEqual(r.charges, getCharges({ broker: "fyers", isFutures: true, entryPremium: 24000, exitPremium: 24100, qty: 65 }),
    "the futures binding must bill futures charges");
});

check("`isSpot` is NOT a charges parameter — only `isFutures` switches the rates", () => {
  // haScalpPaper and earlyBirdPaper historically passed `isSpot: false`. It was
  // silently ignored, which was harmless only because false was also the intent.
  const bogus = calcCharges({ isSpot: true, entryPremium: 24000, exitPremium: 24100, qty: 65 });
  const opts  = calcCharges({ isFutures: false, entryPremium: 24000, exitPremium: 24100, qty: 65 });
  assert.strictEqual(bogus.total, opts.total, "isSpot must not be mistaken for a rate switch — pass isFutures");
});

check("unrealised P&L follows the same split as the booked P&L", () => {
  assert.strictEqual(fut.unrealisedPnl({ side: "PE", entrySpot: 24000, currentSpot: 23950, qty: 65 }), 3250,
    "a short 50pt in profit on 65 qty = ₹3,250");
  assert.strictEqual(instrumentMode.unrealisedPnl({ side: "PE", entrySpot: 24000, currentSpot: 23950,
    entryPremium: 100, currentPremium: 110, qty: 65 }), 650, "the options binding prices the premium");
});

check("futures capital is margin, not notional", () => {
  const notional = 65 * 24000;
  const c = fut.capitalRequired(65, 24000);
  assert.ok(c > 0 && c < notional / 2, `futures capital ${c} looks like the notional ${notional}`);
});

check("resolveEntryInstrument on the futures binding returns the month FUT, priced at the index", async () => {
  const r = await fut.resolveEntryInstrument(24000, "PE", "TEST");
  assert.strictEqual(r.isFutures, true);
  assert.ok(/^NSE:NIFTY\d{2}[A-Z]{3}FUT$/.test(r.symbol), `unexpected futures symbol "${r.symbol}"`);
  assert.strictEqual(r.strike, null, "a future has no strike");
  assert.strictEqual(r.entryPremium, 24000, "a future trades AT the index level");
  assert.strictEqual(r.direction, -1, "a PE entry is a SHORT future");
});

// ─────────────────────────────────────────────────────────────────────────────
section("Futures symbols and sizing — by explicit argument only");

check("getSymbolSync(side, u, \"NIFTY_FUTURES\") is a FUT contract with no strike and no side", () => {
  withEnv({ INSTRUMENT: undefined }, () => {
    for (const side of ["CE", "PE"]) {
      const sym = instrument.getSymbolSync(side, undefined, "NIFTY_FUTURES");
      assert.ok(/^NSE:NIFTY\d{2}[A-Z]{3}FUT$/.test(sym), `unexpected futures symbol "${sym}"`);
      assert.ok(!/CE$|PE$/.test(sym), "a futures symbol must not carry an option side");
    }
  });
});

check("getSymbol(side, u, \"NIFTY_FUTURES\") resolves the same FUT contract", async () => {
  const sym = await instrument.getSymbol("PE", undefined, "NIFTY_FUTURES");
  assert.strictEqual(sym, instrument.getSymbolSync("CE", undefined, "NIFTY_FUTURES"));
});

check("getLotQty(undefined, \"NIFTY_FUTURES\") is the futures lot — identical to options", () => {
  const sizes = instrument.LOT_SIZE;
  assert.strictEqual(sizes.NIFTY_OPTIONS, sizes.NIFTY_FUTURES,
    "a divergence here would silently mis-size every futures order");
  withEnv({ LOT_MULTIPLIER: "2" }, () => {
    assert.strictEqual(instrument.getLotQty(undefined, "NIFTY_FUTURES"), sizes.NIFTY_FUTURES * 2,
      "the futures lot must honour LOT_MULTIPLIER like the options lot");
    assert.strictEqual(instrument.getLotQty(undefined, "NIFTY_FUTURES"), instrument.getLotQty());
  });
});

// ─────────────────────────────────────────────────────────────────────────────
section("A short futures position is not reported as a loss");

check("the contract note reverses the buy/sell legs on a SHORT future", () => {
  const { contractRow } = require("../src/utils/contractNote");
  // PE on futures = SHORT. Entering at 24000 and exiting at 23900 is a 100pt WIN.
  const r = contractRow({ side: "PE", isFutures: true, spotAtEntry: 24000, spotAtExit: 23900, qty: 65 }, "fyers");
  assert.strictEqual(r.segment, "F&O - Futures");
  assert.ok(r.gross > 0, `a winning short must show a positive gross, got ${r.gross}`);
  assert.strictEqual(r.buy, 23900, "the BUY leg of a short is the exit");
  assert.strictEqual(r.sell, 24000, "the SELL leg of a short is the entry");
});

check("the contract note leaves BOUGHT options exactly as they were", () => {
  const { contractRow } = require("../src/utils/contractNote");
  const r = contractRow({ side: "PE", isFutures: false, optionEntryLtp: 200, optionExitLtp: 250,
                          spotAtEntry: 24000, spotAtExit: 23900, qty: 65 }, "fyers");
  assert.strictEqual(r.segment, "F&O - Options");
  assert.strictEqual(r.buy, 200);
  assert.strictEqual(r.sell, 250);
  assert.strictEqual(r.gross, 3250, "a bought option's gross is the premium move");
});

check("ORB's per-trade rupee cap does not exit a WINNING futures short", () => {
  const orbExits = require("../src/strategies/orbExits");
  withEnv({ ORB_MAX_TRADE_LOSS: "1500" }, () => {
    const pos = { isFutures: true, side: "PE", entrySpot: 24000, optionEntryLtp: 24000,
                  qty: 65, slSpot: 24040, peakPremium: 24000, entryTimeMs: Date.now() };
    // Spot fell 100pt — the short is up ₹6,500. Unsigned maths would read -₹6,500
    // and trip the cap.
    const d = orbExits.evaluateTickExits(pos, { spotPrice: 23900, optionLtp: 23900 });
    assert.strictEqual(d.exit, false, `winning short was exited: ${d.reason}`);
  });
});

check("ORB's premium disaster stop cannot fire on futures", () => {
  const orbExits = require("../src/strategies/orbExits");
  // optionLtp mirrors the SPOT on a futures position, so an unguarded premium
  // stop would be testing a 35% fall in NIFTY itself.
  const pos = { isFutures: true, side: "CE", entrySpot: 24000, optionEntryLtp: 24000,
                qty: 65, slSpot: 1, peakPremium: 24000, entryTimeMs: Date.now() };
  const d = orbExits.evaluateTickExits(pos, { spotPrice: 15000, optionLtp: 15000 });
  assert.ok(!/Premium disaster stop/.test(d.reason || ""), `futures must not hit a premium stop, got: ${d.reason}`);
});

// ─────────────────────────────────────────────────────────────────────────────
section("Replay pins the RECORDED INSTRUMENT — and the pin cannot resurrect the toggle");

check("the recorded INSTRUMENT is pinned, not taken from today's env", () => {
  const { _internals } = require("../src/services/tickReplay");
  const f = _internals._resolveReplayInstrumentEnv;
  assert.ok(typeof f === "function", "tickReplay must resolve the recorded instrument");
  withEnv({ INSTRUMENT: "NIFTY_OPTIONS" }, () => {
    assert.strictEqual(f({ INSTRUMENT: "NIFTY_FUTURES" }).INSTRUMENT, "NIFTY_FUTURES");
  });
  withEnv({ INSTRUMENT: "NIFTY_FUTURES" }, () => {
    assert.strictEqual(f({ INSTRUMENT: "NIFTY_OPTIONS" }).INSTRUMENT, "NIFTY_OPTIONS");
  });
});

check("a legacy recording with no INSTRUMENT replays as OPTIONS", () => {
  const { _internals } = require("../src/services/tickReplay");
  const f = _internals._resolveReplayInstrumentEnv;
  withEnv({ INSTRUMENT: "NIFTY_FUTURES" }, () => {
    assert.strictEqual(f({}).INSTRUMENT, "NIFTY_OPTIONS");
    assert.strictEqual(f({ INSTRUMENT: "junk" }).INSTRUMENT, "NIFTY_OPTIONS");
  });
});

check("applying a pinned NIFTY_FUTURES recording env leaves every options route on options", () => {
  // A session recorded under the old toggle replays through its OPTIONS route.
  // The pin lands in process.env; it must not flip that route to futures now.
  const { _internals } = require("../src/services/tickReplay");
  const pinned = _internals._resolveReplayInstrumentEnv({ INSTRUMENT: "NIFTY_FUTURES" });
  withEnv(pinned, () => {
    assert.strictEqual(process.env.INSTRUMENT, "NIFTY_FUTURES", "fixture: the pin is applied");
    assert.strictEqual(instrument.INSTRUMENT, "NIFTY_OPTIONS");
    assert.strictEqual(instrumentMode.isFutures(), false);
    assert.ok(/CE$/.test(instrument.getSymbolSync("CE")));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
section("Alerts and history label the instrument they actually traded");

check("a Telegram alert trusts the payload, and a FUT_* mode is always futures", () => {
  // EARLYBIRD can hold an index position and a cash-equity leg at the same time;
  // the equity leg must never be labelled futures.
  const src = read("utils/notify.js");
  assert.ok(/function _isFuturesAlert/.test(src), "notify.js must resolve the instrument centrally");
  const fnSrc = src.slice(src.indexOf("function _isFuturesAlert"));
  assert.ok(/p\.isFutures === false\) return false/.test(fnSrc),
    "an explicit isFutures:false in the payload must win for an options strategy");
  assert.ok(/p\.isSpot === true\) return false/.test(fnSrc),
    "a cash-equity leg must never be labelled futures");
  assert.ok(/\^FUT\[_-\]/.test(fnSrc), "a FUT_* twin's mode must classify its alert as futures");
});

check("the trade-history modal reads each TRADE's own instrument, not a global", () => {
  const src = read("utils/paperHistoryUI.js");
  assert.ok(/t\.isFutures \|\| t\.instrument === 'NIFTY_FUTURES'/.test(src),
    "history can mix both instruments — the label must follow the row, never process.env");
});

check("consolidation carries the trade's instrument through to the row", () => {
  const src = decomment(read("routes/consolidation.js"));
  assert.ok(/instrument:\s*t\.instrument \|\| s\.instrument/.test(src),
    "consolidation takes the instrument from the SESSION, so a mixed history mislabels rows");
  assert.ok(/isFutures:\s*t\.isFutures === true/.test(src),
    "consolidation drops isFutures, so downstream cannot tell the instruments apart");
});

// ─────────────────────────────────────────────────────────────────────────────
section("No source can resurrect the removed toggle");

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "node_modules" && !e.name.startsWith(".")) walk(full, out); }
    else if (e.name.endsWith(".js")) out.push(full);
  }
  return out;
}

check("nothing in src/ READS process.env.INSTRUMENT", () => {
  const offenders = [];
  for (const file of walk(SRC)) {
    const src = codeOf(fs.readFileSync(file, "utf-8"));
    if (/process\.env\.INSTRUMENT\b|process\.env\[\s*["'`]INSTRUMENT["'`]\s*\]/.test(src)) {
      offenders.push(path.relative(SRC, file));
    }
  }
  assert.deepStrictEqual(offenders, [],
    `these files read the removed INSTRUMENT toggle directly: ${offenders.join(", ")}`);
});

check("config/instrument.js getInstrument() is hard-wired to options", () => {
  const src = codeOf(read("config/instrument.js"));
  const body = src.slice(src.indexOf("function getInstrument("), src.indexOf("}", src.indexOf("function getInstrument(")) + 1);
  assert.ok(body.length > 20, "getInstrument() not found");
  assert.ok(!/process\.env/.test(body), "getInstrument() reads process.env again — the toggle is back");
  assert.ok(/return\s+["']NIFTY_OPTIONS["']/.test(body), "getInstrument() must return the options literal");
});

// ─────────────────────────────────────────────────────────────────────────────
section("Every FUT_* twin forces futures — discovered from disk, not listed");

const allRoutes   = fs.readdirSync(ROUTES).filter(f => f.endsWith(".js")).sort();
const futRoutes   = allRoutes.filter(f => /^fut[A-Z][A-Za-z0-9]*(Paper|Backtest)\.js$/.test(f));
const futPaper    = futRoutes.filter(f => /Paper\.js$/.test(f));
const futBacktest = futRoutes.filter(f => /Backtest\.js$/.test(f));

check("the discovery actually found the futures twins", () => {
  assert.ok(futPaper.length >= 7, `expected ≥7 fut*Paper.js twins, found ${futPaper.length} — has the naming changed?`);
  assert.ok(futBacktest.length >= 5, `expected ≥5 fut*Backtest.js twins, found ${futBacktest.length}`);
});

// Allowed sources for a futures flag inside a twin (INSTRUMENT is the literal there).
const FUT_FLAG_OK = /\bINSTR(UMENT)?\s*===\s*["']NIFTY_FUTURES["']|instrumentMode\.isFutures\(\)|\.isFutures\s*===\s*true|^true\b/;

for (const file of futRoutes) {
  const src = codeOf(read(path.join("routes", file)));
  const forcesByConst  = /\bconst\s+INSTRUMENT\s*=\s*["']NIFTY_FUTURES["']/.test(src);
  const forcesByBinding = /require\(\s*["']\.\.\/utils\/instrumentMode["']\s*\)\.futures\b/.test(src);
  const chargeCalls = [...callsOf(src, "getCharges"), ...callsOf(src, "calcCharges")];
  const isThinBacktest = /Backtest\.js$/.test(file) && !forcesByConst && !forcesByBinding && chargeCalls.length === 0;

  check(`${file} never reads the options-only global instrument`, () => {
    assert.ok(!/\binstrumentConfig\.INSTRUMENT\b|\binstrument\.INSTRUMENT\b/.test(src),
      `${file} reads instrumentConfig.INSTRUMENT — always NIFTY_OPTIONS now, so it would trade options`);
    if (/\binstrumentMode\b/.test(src)) {
      assert.ok(forcesByBinding,
        `${file} uses the DEFAULT instrumentMode export — that is the options binding; require(...).futures`);
    }
  });

  check(`${file} pins NIFTY_FUTURES (literal const, instrumentMode.futures, or engine isFutures:true)`, () => {
    if (isThinBacktest) {
      // The flag must ride on the ENGINE call itself (inline or via a const) — an
      // isFutures:true anywhere else in the file (a summary stamp) proves nothing.
      const engineCalls = ["runBacktest", "runEma9VwapBacktest"].flatMap(fn => callsOf(src, fn));
      assert.ok(engineCalls.length > 0, `${file} delegates to no known backtest engine`);
      for (const args of engineCalls) {
        const viaConst = bindingsOf(src, "[A-Z_][A-Z0-9_]*").some(b =>
          new RegExp(`\\b${b.name}\\b`).test(args) && /isFutures:\s*true/.test(b.rhs));
        assert.ok(/isFutures:\s*true/.test(args) || viaConst,
          `${file}: engine call (${args.replace(/\s+/g, " ").slice(0, 120)}…) carries no isFutures:true — it would size and bill options`);
      }
      return;
    }
    assert.ok(forcesByConst || forcesByBinding,
      `${file} has neither \`const INSTRUMENT = "NIFTY_FUTURES"\` nor require("../utils/instrumentMode").futures`);
    for (const b of bindingsOf(src, "INSTRUMENT|INSTR\\w*")) {
      assert.ok(FUT_LIT.test(b.rhs) || /^INSTRUMENT\b/.test(b.rhs),
        `${file}: ${b.name} = ${b.rhs} — every instrument binding in a twin must be the futures literal`);
    }
  });

  check(`${file} passes "NIFTY_FUTURES" on every getSymbol / getSymbolSync / getLotQty call`, () => {
    for (const fn of ["getSymbol", "getSymbolSync", "getLotQty"]) {
      for (const args of callsOf(src, fn)) {
        assert.ok(FUT_LIT.test(args), `${file}: ${fn}(${args}) — without "NIFTY_FUTURES" this resolves an OPTION`);
      }
    }
  });

  check(`${file} bills every trade at futures rates (isFutures:true)`, () => {
    assert.ok(!/isFutures:\s*false/.test(src), `${file} hardcodes isFutures:false`);
    assert.ok(!/instrument:\s*["']NIFTY_OPTIONS["']/.test(src), `${file} stamps a record as NIFTY_OPTIONS`);
    for (const args of chargeCalls) {
      const named = args.match(/\bisFutures\s*:\s*([A-Za-z_$][\w$.]*|true|false)/);
      const shorthand = /(^|[{,])\s*isFutures\s*(?=[,}])/.test(args);
      assert.ok(named || shorthand, `${file}: getCharges(${args.trim()}) passes no isFutures — it bills option STT`);
      const id = named ? named[1] : "isFutures";
      if (id === "true") continue;
      const binds = bindingsOf(src, id.replace(/[$.]/g, "\\$&"));
      assert.ok(binds.length > 0, `${file}: charges flag ${id} has no binding in the file`);
      for (const b of binds) {
        assert.ok(FUT_FLAG_OK.test(b.rhs) && !/\bfalse\b/.test(b.rhs),
          `${file}: charges flag ${id} = ${b.rhs} — not provably futures`);
      }
    }
  });

  if (/Paper\.js$/.test(file)) {
    check(`${file} resolves a FUTURES contract and prices its exit direction-signed`, () => {
      const resolvesFut = callsOf(src, "getSymbol").some(a => FUT_LIT.test(a)) ||
                          /instrumentMode\.resolveEntryInstrument\(/.test(src);
      assert.ok(resolvesFut, `${file} never resolves the futures contract`);
      const signed = /\(\s*side\s*===\s*["']CE["']\s*\?\s*1\s*:\s*-1\s*\)/.test(src) ||
                     /instrumentMode\.computePnl\(/.test(src);
      assert.ok(signed, `${file} has no direction-signed P&L — a winning SHORT would book as a loss`);
      assert.ok(/isFutures:\s*true/.test(src), `${file} never stamps isFutures:true on its records`);
    });
  }
}

check("the backtest engines a thin twin delegates to size and bill futures when told to", () => {
  const be = codeOf(read("services/backtestEngine.js"));
  assert.ok(/btOpts\.isFutures === true/.test(be) && /getLotQty\(\s*undefined\s*,\s*["']NIFTY_FUTURES["']\s*\)/.test(be),
    "backtestEngine must size the lot as a future when btOpts.isFutures is true");
  const ev = codeOf(read("services/ema9vwapBacktestEngine.js"));
  assert.ok(/opts\.isFutures === true\s*\?\s*getLotQty\(\s*["']NIFTY["']\s*,\s*["']NIFTY_FUTURES["']\s*\)/.test(ev),
    "ema9vwapBacktestEngine must size the lot as a future when opts.isFutures is true");
});

// ─────────────────────────────────────────────────────────────────────────────
section("Every other route trades options only — it cannot reach futures through the removed toggle");

const nonFutRoutes = allRoutes.filter(f => /(Paper|Backtest)\.js$/.test(f) && !futRoutes.includes(f));
// A flag in an options route may only come from the options-only getter, the
// default (options) instrumentMode binding, or a position's own recorded flag.
const OPT_FLAG_OK = /instrumentConfig\.INSTRUMENT\b|\bINSTR(UMENT)?\s*===\s*["']NIFTY_FUTURES["']|instrumentMode\.isFutures\(\)|\.isFutures\s*===\s*true|^false\b|^["'](?!NIFTY_FUTURES)[A-Z_]+["']/;

check("the discovery found the options routes", () => {
  assert.ok(nonFutRoutes.filter(f => /Paper\.js$/.test(f)).length >= 20,
    `expected the repo's options paper routes, found ${nonFutRoutes.length} routes in all`);
});

for (const file of nonFutRoutes) {
  const src = codeOf(read(path.join("routes", file)));

  check(`${file} never asks for futures and never binds a futures source`, () => {
    for (const fn of ["getSymbol", "getSymbolSync", "getLotQty", "resolveInstrument", "forInstrument"]) {
      for (const args of callsOf(src, fn)) {
        assert.ok(!FUT_LIT.test(args), `${file}: ${fn}(${args}) requests FUTURES from an options route`);
      }
    }
    assert.ok(!/instrumentMode\s*\.\s*futures\b|\)\s*\.\s*futures\b|\.forInstrument\(/.test(src),
      `${file} reaches for the futures instrumentMode binding`);
    for (const b of bindingsOf(src, "INSTRUMENT|INSTR\\w*|_?IS_FUT\\w*|_?isFut\\w*")) {
      assert.ok(OPT_FLAG_OK.test(b.rhs) && !/^true\b/.test(b.rhs) && !(FUT_LIT.test(b.rhs) && !/===|!==/.test(b.rhs)),
        `${file}: ${b.name} = ${b.rhs} — an options route's instrument flag must come from the options-only getter`);
    }
  });

  check(`${file} has no live futures literal — only comparisons and position-derived stamps`, () => {
    const re = /["']NIFTY_FUTURES["']/g;
    let m;
    while ((m = re.exec(src))) {
      const before = src.slice(Math.max(0, m.index - 60), m.index);
      const ok = /[!=]==\s*$/.test(before) || /\.isFutures\s*\?\s*$/.test(before);
      assert.ok(ok, `${file}: a bare "NIFTY_FUTURES" near …${before.slice(-40)}… — only comparisons or pos.isFutures stamps are allowed`);
    }
    const tr = /isFutures:\s*true/g;
    while ((m = tr.exec(src))) {
      const before = src.slice(Math.max(0, m.index - 600), m.index);
      assert.ok(/if\s*\(\s*!?\s*(_?IS_FUT\w*|_?isFut\w*)\s*\)/.test(before),
        `${file}: isFutures:true outside a branch on an options-only flag`);
    }
  });

  if (NOT_NIFTY.has(file)) {
    check(`${file} trades MCX only — never touches the NIFTY instrument code`, () => {
      assert.ok(!/config\/instrument|instrumentMode|NIFTY_FUTURES/.test(src),
        `${file} must never build a NIFTY symbol`);
      assert.ok(/commodityPaper/.test(src), `${file} must run on the commodity engine`);
    });
  } else if (stockUnderlyingOf(file)) {
    const U = stockUnderlyingOf(file);
    check(`${file} trades ${U} stock options only — never a NIFTY contract`, () => {
      if (/Paper\.js$/.test(file)) {
        const calls = src.match(/validateAndGetOptionSymbol\([^)]*\)/g) || [];
        assert.ok(calls.length > 0, `${file} must resolve its option through validateAndGetOptionSymbol`);
        for (const c of calls) assert.ok(/underlying:\s*UNDERLYING/.test(c), `${file}: ${c} does not name the ${U} underlying`);
        assert.ok(!/\bgetSymbol\(|\bgetLotQty\(/.test(src), `${file} must not call the NIFTY-default getSymbol/getLotQty`);
      } else {
        assert.ok(/underlyingOf\(\s*["']SAIL["']\s*\)|UNDERLYING/.test(src), `${file} must fetch its own stock's candles`);
      }
      const eng = require(path.join(ROUTES, "..", "strategies", "sail_vwap_st"));
      assert.strictEqual(eng.UNDERLYING, U);
    });
  } else if (OPTIONS_ONLY_BY_RULE.has(file)) {
    check(`${file} always buys the exact-ATM NIFTY option`, () => {
      assert.ok(!/NIFTY_FUTURES|instrumentMode|\bgetSymbol\(|\bgetLotQty\(/.test(src),
        `${file} must stay out of the instrument-switching code entirely`);
      const calls = src.match(/validateAndGetOptionSymbol\([^)]*\)/g) || [];
      assert.ok(calls.length > 0, `${file} must resolve its option through validateAndGetOptionSymbol`);
      for (const c of calls) assert.ok(/strikeOverride/.test(c), `${file}: ${c} does not pin the ATM strike`);
      assert.ok(/instrument:\s*"NIFTY_OPTIONS"/.test(src), `${file} must stamp the instrument it traded`);
    });
  } else if (CASH_EQUITY_ONLY.has(file)) {
    check(`${file} trades cash equity only — never touches the NIFTY instrument code`, () => {
      assert.ok(!/config\/instrument|instrumentMode|NIFTY_FUTURES|validateAndGetOptionSymbol/.test(src),
        `${file} must never build a NIFTY symbol`);
      assert.ok(/instrument:\s*"NSE_EQUITY_MIS"/.test(src), `${file} must stamp the instrument it traded`);
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
section("Futures backtests price 1:1 — no delta, no theta");

// Only the twins that run their OWN premium simulation. The thin wrappers
// delegate to an engine that is told isFutures:true (asserted above).
const futSelfSim = futBacktest.filter(f => {
  const s = read(path.join("routes", f));
  return /BACKTEST_DELTA/.test(s) && /BACKTEST_THETA_DAY/.test(s);
});

check("the discovery found the self-simulating futures backtests", () => {
  assert.ok(futSelfSim.length >= 3, `expected ≥3 self-simulating fut*Backtest.js, found ${futSelfSim.length}`);
});

for (const file of futSelfSim) {
  const src = codeOf(read(path.join("routes", file)));
  check(`${file} neutralises delta and theta (it is always futures)`, () => {
    const deltaOne  = /\?\s*1\.0\s*:/.test(src) || /delta:\s*1\.0/.test(src);
    const thetaZero = /\?\s*0\s+:/.test(src) || /thetaPerDay:\s*0/.test(src);
    assert.ok(deltaOne && thetaZero,
      `${file} must collapse δ→1 / θ→0 — a 0.55 delta on a 1:1 instrument halves every move`);
    const flag = bindingsOf(src, "IS_FUT|isFutures");
    assert.ok(flag.length > 0 && flag.every(b => FUT_FLAG_OK.test(b.rhs)),
      `${file}: the δ/θ switch must hang off the futures literal`);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
section("Every twin mirrors a real options strategy — and never one that cannot be futures");

check("each fut*X.js has its options original x*.js, and that original may have a futures twin", () => {
  for (const f of futRoutes) {
    const orig = f.charAt(3).toLowerCase() + f.slice(4);
    assert.ok(allRoutes.includes(orig), `${f} has no options original ${orig} — what does it mirror?`);
    assert.ok(!NEVER_A_FUTURES_TWIN(orig),
      `${f} is a futures twin of ${orig}, whose levels/underlying have no NIFTY-futures meaning`);
  }
});

check("the never-a-twin sets still name real routes (an empty exemption is a dead one)", () => {
  for (const f of [...PREMIUM_DENOMINATED, ...STOCK_OPTIONS.SAIL, ...OPTIONS_ONLY_BY_RULE, ...CASH_EQUITY_ONLY]) {
    assert.ok(allRoutes.includes(f), `${f} is listed but no longer exists — drop it from the set`);
  }
  assert.ok(allRoutes.some(f => NOT_NIFTY.has(f)), "no cmx*Paper.js route found — drop NOT_NIFTY");
});

// ─────────────────────────────────────────────────────────────────────────────
(async () => {
  for (const item of _queue) {
    if (item.section) { console.log(`\n${item.section}`); continue; }
    try { await item.fn(); console.log(`  ✅ ${item.name}`); pass++; }
    catch (e) { console.log(`  ❌ ${item.name}\n       ${e.message}`); fail++; }
  }
  console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();

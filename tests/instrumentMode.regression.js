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
 *   - futures can only be asked for EXPLICITLY on a call — a literal
 *     "NIFTY_FUTURES" argument to getSymbol / getSymbolSync / getLotQty, or the
 *     pinned `instrumentMode.futures` binding. No route does so today.
 *
 * The route groups DISCOVER the routes from disk rather than listing them: every
 * route must prove it cannot reach futures through any path the removed toggle
 * used to open.
 *
 * Exemption sets are kept, re-expressed: the strategies they name (premium-
 * denominated, stock options, cash equity, options-by-rule) each prove
 * their own instrument rule — asserted in the last groups.
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

// ── Strategies with their own instrument rule ───────────────────────────────
// They used to be EXEMPT from the global toggle; with the toggle gone they are
// options-only like everything else, and each proves its own rule below.
//
// Premium-denominated: the trigger, stop and trail are all option-premium levels.
const PREMIUM_DENOMINATED = new Set(["simple930Paper.js", "itm20ScalpPaper.js", "itm20ScalpBacktest.js"]);
// STOCK-option strategies — every contract names its own stock underlying.
const STOCK_OPTIONS = { SAIL: new Set(["sailVwapStPaper.js", "sailVwapStBacktest.js"]) };
const stockUnderlyingOf = (f) => Object.keys(STOCK_OPTIONS).find((k) => STOCK_OPTIONS[k].has(f)) || null;
// GAP_RUNAWAY: by the user's rule NO common setting applies to it — it always
// buys the exact-ATM NIFTY option.
const OPTIONS_ONLY_BY_RULE = new Set(["gapRunawayPaper.js"]);
// Its stock scanner trades CASH EQUITY (intraday shares) — no NIFTY contract.
const CASH_EQUITY_ONLY = new Set(["gapRunawayStkPaper.js"]);

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

check("a Telegram alert trusts the payload", () => {
  // EARLYBIRD can hold an index position and a cash-equity leg at the same time;
  // the equity leg must never be labelled futures.
  const src = read("utils/notify.js");
  assert.ok(/function _isFuturesAlert/.test(src), "notify.js must resolve the instrument centrally");
  const fnSrc = src.slice(src.indexOf("function _isFuturesAlert"));
  assert.ok(/p\.isFutures === false\) return false/.test(fnSrc),
    "an explicit isFutures:false in the payload must win for an options strategy");
  assert.ok(/p\.isSpot === true\) return false/.test(fnSrc),
    "a cash-equity leg must never be labelled futures");
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
section("The backtest engines still size and bill futures when told to");

const allRoutes = fs.readdirSync(ROUTES).filter(f => f.endsWith(".js")).sort();

check("the backtest engines size and bill futures when told to", () => {
  const be = codeOf(read("services/backtestEngine.js"));
  assert.ok(/btOpts\.isFutures === true/.test(be) && /getLotQty\(\s*undefined\s*,\s*["']NIFTY_FUTURES["']\s*\)/.test(be),
    "backtestEngine must size the lot as a future when btOpts.isFutures is true");
  const ev = codeOf(read("services/ema9vwapBacktestEngine.js"));
  assert.ok(/opts\.isFutures === true\s*\?\s*getLotQty\(\s*["']NIFTY["']\s*,\s*["']NIFTY_FUTURES["']\s*\)/.test(ev),
    "ema9vwapBacktestEngine must size the lot as a future when opts.isFutures is true");
});

// ─────────────────────────────────────────────────────────────────────────────
section("Every other route trades options only — it cannot reach futures through the removed toggle");

const nonFutRoutes = allRoutes.filter(f => /(Paper|Backtest)\.js$/.test(f));
// A flag in an options route may only come from the options-only getter, the
// default (options) instrumentMode binding, or a position's own recorded flag.
// A create(pair) builder's flag comes from pairRuntime.instrumentName(), which on
// the route's own (home) instance IS instrumentConfig.INSTRUMENT — checked below;
// only a NIFTY_FUT pair instance answers futures.
const OPT_FLAG_OK = /instrumentConfig\.INSTRUMENT\b|^rt\.instrumentName\(\)|\bINSTR(UMENT)?\s*===\s*["']NIFTY_FUTURES["']|instrumentMode\.isFutures\(\)|\.isFutures\s*===\s*true|^false\b|^["'](?!NIFTY_FUTURES)[A-Z_]+["']/;

check("a builder route's home instance answers the options-only getter (only its NIFTY_FUT pair trades futures)", () => {
  const pairRuntime = require("../src/utils/pairRuntime");
  const instrument = require("../src/config/instrument");
  const pairs = require("../src/config/pairs");
  for (const id of pairs.RUNS_AS_PAIR) {
    // A strategy whose home is not NIFTY (SAIL_VWAP_ST) answers its own options instrument.
    const home = pairRuntime.forStrategy(id);
    assert.strictEqual(home.instrumentName(), pairs.homeMarket(id) === "NIFTY" ? instrument.INSTRUMENT : `${home.underlyingKey}_OPTIONS`, id);
    for (const p of pairs.runnable().filter(x => x.strategyId === id)) {
      assert.strictEqual(pairRuntime.forPair(p).instrumentName() === "NIFTY_FUTURES", p.marketKey === "NIFTY_FUT", p.id);
    }
  }
});

check("the discovery found the options routes", () => {
  assert.ok(nonFutRoutes.filter(f => /Paper\.js$/.test(f)).length >= 19,   // 17 NIFTY + SAIL_VWAP_ST + GAP_RUNAWAY_STK
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

  if (stockUnderlyingOf(file)) {
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
    // Its NIFTY instance always buys the exact-ATM NIFTY option; another
    // market's pair (create(pair)) buys that market's exact ATM, and only the
    // NIFTY_FUT pair takes the month future (via pairRuntime, never a global switch).
    check(`${file} always buys the exact-ATM NIFTY option`, () => {
      assert.ok(!/NIFTY_FUTURES|instrumentMode|\bgetSymbol\(|\bgetLotQty\(/.test(src),
        `${file} must stay out of the instrument-switching code entirely`);
      const calls = src.match(/validateAndGetOptionSymbol\([^)]*\)/g) || [];
      assert.ok(calls.length > 0, `${file} must resolve its option through validateAndGetOptionSymbol`);
      for (const c of calls) assert.ok(/strikeOverride/.test(c), `${file}: ${c} does not pin the ATM strike`);
      assert.ok(/instrument:\s*(rt\.home\s*\?\s*)?"NIFTY_OPTIONS"|rt\.home\s*\?\s*"NIFTY_OPTIONS"/.test(src), `${file} must stamp the instrument it traded`);
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
section("The options-only exemption sets still name real routes");

check("the never-a-twin sets still name real routes (an empty exemption is a dead one)", () => {
  for (const f of [...PREMIUM_DENOMINATED, ...STOCK_OPTIONS.SAIL, ...OPTIONS_ONLY_BY_RULE, ...CASH_EQUITY_ONLY]) {
    assert.ok(allRoutes.includes(f), `${f} is listed but no longer exists — drop it from the set`);
  }
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

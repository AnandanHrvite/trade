#!/usr/bin/env node
/**
 * INSTRUMENT-MODE INVARIANTS — the Settings toggle must reach EVERY strategy
 *
 *   node tests/instrumentMode.regression.js
 *
 * Zero dependencies, zero framework, exits non-zero on failure. Nothing here opens
 * a socket, a broker connection or a session.
 *
 * The rule this suite defends: `INSTRUMENT` (NIFTY_OPTIONS | NIFTY_FUTURES) is one
 * global Settings toggle, and flipping it must change what EVERY strategy trades.
 *
 * The defect it pins (found 2026-08-31): the toggle was honoured by only 5 of the
 * 11 strategies. Each of those 5 hand-rolled its own `INSTRUMENT === "NIFTY_FUTURES"`
 * branch, so every strategy written afterwards silently kept buying options no
 * matter what the toggle said — no error, no warning, just the wrong instrument.
 *
 * GROUP 3 is the one that matters long-term: it DISCOVERS the paper routes from
 * disk rather than listing them. A strategy added next year is enrolled the moment
 * its `*Paper.js` file exists — it cannot ship futures-blind without failing here.
 *
 * Opting out is allowed, but it must be DELIBERATE and DECLARED: a route whose
 * premium levels have no futures meaning (SIMPLE930 — its trigger, stop and trail
 * are all option-premium levels) is listed in PREMIUM_DENOMINATED below, and must
 * prove it REFUSES to run in futures mode rather than quietly trading options.
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

let pass = 0, fail = 0;
function section(t) { console.log(`\n${t}`); }
function check(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); pass++; }
  catch (e) { console.log(`  ❌ ${name}\n       ${e.message}`); fail++; }
}

const instrumentMode = require("../src/utils/instrumentMode");
const { calcCharges } = require("../src/utils/charges");

// Strategies whose price axis IS an option premium, so "the same strategy in
// futures" does not exist. They must refuse the mode, not silently ignore it.
const PREMIUM_DENOMINATED = new Set(["simple930Paper.js"]);

// ─────────────────────────────────────────────────────────────────────────────
section("The helper itself — direction, P&L and charge rates");

check("the toggle is read per call, so a Settings save needs no restart", () => {
  const prev = process.env.INSTRUMENT;
  try {
    process.env.INSTRUMENT = "NIFTY_FUTURES";
    assert.strictEqual(instrumentMode.isFutures(), true);
    process.env.INSTRUMENT = "NIFTY_OPTIONS";
    assert.strictEqual(instrumentMode.isFutures(), false);
  } finally { process.env.INSTRUMENT = prev; }
});

check("a PE is a SHORT in futures and a BOUGHT option otherwise", () => {
  const prev = process.env.INSTRUMENT;
  try {
    process.env.INSTRUMENT = "NIFTY_FUTURES";
    assert.strictEqual(instrumentMode.directionFor("PE"), -1, "PE must be SHORT in futures");
    assert.strictEqual(instrumentMode.directionFor("CE"), +1, "CE must be LONG in futures");
    process.env.INSTRUMENT = "NIFTY_OPTIONS";
    assert.strictEqual(instrumentMode.directionFor("PE"), +1, "a bought PE gains as its premium rises");
  } finally { process.env.INSTRUMENT = prev; }
});

check("a futures PE PROFITS when NIFTY falls (the sign bug this prevents)", () => {
  const prev = process.env.INSTRUMENT;
  try {
    process.env.INSTRUMENT = "NIFTY_FUTURES";
    const r = instrumentMode.computePnl({
      side: "PE", entrySpot: 24000, exitSpot: 23900, qty: 65, broker: "fyers",
    });
    assert.ok(r.gross > 0, `a 100pt fall on a short must be a GAIN, got gross ${r.gross}`);
    assert.strictEqual(r.gross, 6500, "100pt × 65 = ₹6,500");
    assert.ok(/SHORT/.test(r.pnlMode), `pnlMode must record the direction, got "${r.pnlMode}"`);
  } finally { process.env.INSTRUMENT = prev; }
});

check("futures P&L is index points × qty, NOT a premium difference", () => {
  const prev = process.env.INSTRUMENT;
  try {
    process.env.INSTRUMENT = "NIFTY_FUTURES";
    const r = instrumentMode.computePnl({
      side: "CE", entrySpot: 24000, exitSpot: 24100,
      // Premium args must be IGNORED in futures mode — passing them is how a
      // half-converted call site would otherwise silently keep option maths.
      entryPremium: 200, exitPremium: 100,
      qty: 65, broker: "fyers",
    });
    assert.strictEqual(r.gross, 6500, "must price the SPOT move, not the premium args");
    assert.strictEqual(r.isFutures, true);
  } finally { process.env.INSTRUMENT = prev; }
});

check("futures are billed at FUTURES statutory rates, not option rates", () => {
  const opt = calcCharges({ isFutures: false, entryPremium: 24000, exitPremium: 24100, qty: 65 });
  const fut = calcCharges({ isFutures: true,  entryPremium: 24000, exitPremium: 24100, qty: 65 });
  assert.ok(fut.stt < opt.stt, `futures STT (${fut.stt}) must be below options STT (${opt.stt})`);
  assert.ok(fut.total !== opt.total, "futures and options cannot bill identically");
});

check("`isSpot` is NOT a charges parameter — only `isFutures` switches the rates", () => {
  // haScalpPaper and earlyBirdPaper historically passed `isSpot: false`. It was
  // silently ignored, which was harmless only because false was also the intent.
  // Had either meant "futures", it would have billed option rates forever.
  const bogus = calcCharges({ isSpot: true, entryPremium: 24000, exitPremium: 24100, qty: 65 });
  const opts  = calcCharges({ isFutures: false, entryPremium: 24000, exitPremium: 24100, qty: 65 });
  assert.strictEqual(bogus.total, opts.total,
    "isSpot must not be mistaken for a rate switch — pass isFutures");
});

check("unrealised P&L follows the same split as the booked P&L", () => {
  const prev = process.env.INSTRUMENT;
  try {
    process.env.INSTRUMENT = "NIFTY_FUTURES";
    const live = instrumentMode.unrealisedPnl({
      side: "PE", entrySpot: 24000, currentSpot: 23950, qty: 65,
    });
    assert.strictEqual(live, 3250, "a short 50pt in profit on 65 qty = ₹3,250");
  } finally { process.env.INSTRUMENT = prev; }
});

// ─────────────────────────────────────────────────────────────────────────────
section("Futures symbols and sizing");

check("futures resolve to a FUT contract with no strike and no expiry", async () => {
  const prev = process.env.INSTRUMENT;
  try {
    process.env.INSTRUMENT = "NIFTY_FUTURES";
    // Resolve synchronously via the config layer the helper delegates to — this
    // avoids any network call while still proving the symbol shape.
    const instrument = require("../src/config/instrument");
    const sym = instrument.getSymbolSync("PE");
    assert.ok(/^NSE:NIFTY\d{2}[A-Z]{3}FUT$/.test(sym), `unexpected futures symbol "${sym}"`);
    assert.ok(!/CE$|PE$/.test(sym), "a futures symbol must not carry an option side");
  } finally { process.env.INSTRUMENT = prev; }
});

check("lot size is identical in both modes, so sizing needs no special case", () => {
  const instrument = require("../src/config/instrument");
  const sizes = instrument.LOT_SIZE;
  assert.strictEqual(sizes.NIFTY_OPTIONS, sizes.NIFTY_FUTURES,
    "a divergence here would silently mis-size every futures order");
});

// ─────────────────────────────────────────────────────────────────────────────
section("Every strategy honours the toggle — discovered from disk, not listed");

// Discovering the routes is the whole point: a strategy added later is enrolled
// automatically. Listing them would let the next one ship futures-blind.
const paperRoutes = fs.readdirSync(ROUTES)
  .filter(f => /Paper\.js$/.test(f))
  .sort();

check("the discovery actually found the paper routes", () => {
  assert.ok(paperRoutes.length >= 10,
    `expected the repo's paper routes, found ${paperRoutes.length} — has the naming changed?`);
});

for (const file of paperRoutes) {
  const src = decomment(read(path.join("routes", file)));

  if (PREMIUM_DENOMINATED.has(file)) {
    check(`${file} REFUSES futures mode (its levels are premiums)`, () => {
      assert.ok(/instrumentMode/.test(src),
        `${file} must consult instrumentMode to detect the mode it cannot serve`);
      assert.ok(/isFutures\(\)/.test(src),
        `${file} must test isFutures() to refuse`);
      assert.ok(/gate:\s*"instrument"/.test(src),
        `${file} must log a skip with gate "instrument" so the refusal is visible`);
    });
    continue;
  }

  // The assertions are on BEHAVIOUR, not on one spelling. Five strategies were
  // futures-aware before utils/instrumentMode existed and branch on
  // `instrumentConfig.INSTRUMENT` directly; that is correct and stays passing.
  // What must never be true is a route with NO branch at all.
  const seesToggle = /instrumentMode\.isFutures\(\)/.test(src) ||
                     /INSTRUMENT\s*===\s*["']NIFTY_FUTURES["']/.test(src) ||
                     /["']NIFTY_FUTURES["']\s*===\s*.*INSTRUMENT/.test(src);

  check(`${file} branches on the instrument toggle at all`, () => {
    assert.ok(seesToggle,
      `${file} never tests INSTRUMENT — flipping the Settings toggle to ` +
      `NIFTY_FUTURES would leave it silently buying options`);
  });

  check(`${file} resolves a futures contract instead of an option symbol`, () => {
    const resolvesFut = /instrumentMode\.resolveEntryInstrument\(/.test(src) ||
                        /getSymbol\(/.test(src);
    assert.ok(resolvesFut,
      `${file} only ever calls validateAndGetOptionSymbol — in futures mode it ` +
      `would trade an option contract the operator did not ask for`);
  });

  check(`${file} prices a futures exit on the SPOT move, direction-signed`, () => {
    const viaHelper = /instrumentMode\.computePnl\(/.test(src);
    // The hand-rolled form must both branch AND carry the CE/PE sign, or a
    // profitable short books as a loss.
    const handRolled = seesToggle &&
      /\(\s*side\s*===\s*["']CE["']\s*\?\s*1\s*:\s*-1\s*\)/.test(src);
    assert.ok(viaHelper || handRolled,
      `${file} has no direction-signed futures P&L; a PE (SHORT) that wins would ` +
      `be booked as a loss`);
  });

  check(`${file} bills futures at futures rates, not option rates`, () => {
    assert.ok(!/getCharges\(\{[^}]*isFutures:\s*false/.test(src),
      `${file} hardcodes isFutures:false — futures would be billed option STT`);
  });

  check(`${file} stamps the instrument it actually traded on the trade record`, () => {
    const honest = /instrument:\s*pos\.isFutures\s*\?/.test(src) ||
                   /instrument:\s*instrumentConfig\.INSTRUMENT/.test(src) ||
                   /instrument:\s*INSTR\b/.test(src);
    assert.ok(honest,
      `${file} writes a fixed instrument string; a futures trade would be logged ` +
      `as an option and every downstream analytic would misread it`);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
section("Backtests price futures 1:1 — no delta, no theta");

const btRoutes = fs.readdirSync(ROUTES)
  .filter(f => /Backtest\.js$/.test(f))
  .filter(f => {
    // Only those that run their OWN premium simulation. The thin wrappers
    // delegate to backtestEngine.js, which is futures-aware already.
    const s = read(path.join("routes", f));
    return /BACKTEST_DELTA/.test(s) && /BACKTEST_THETA_DAY/.test(s);
  })
  .sort();

check("the discovery found the self-simulating backtests", () => {
  assert.ok(btRoutes.length >= 4,
    `expected several self-simulating backtests, found ${btRoutes.length}`);
});

for (const file of btRoutes) {
  const src = decomment(read(path.join("routes", file)));
  check(`${file} neutralises delta and theta in futures mode`, () => {
    assert.ok(/NIFTY_FUTURES/.test(src),
      `${file} has no futures branch — it would apply a 0.55 delta to a 1:1 instrument`);
    // Either the δ/θ constants collapse to 1.0/0, or the route prices futures in
    // a dedicated branch that bypasses the premium sim entirely (orbBacktest).
    const deltaOne  = /\?\s*1\.0\s*:/.test(src) || /delta:\s*1\.0/.test(src);
    const thetaZero = /\?\s*0\s+:/.test(src) || /thetaPerDay:\s*0/.test(src);
    const futBranch = /isFutures:\s*true/.test(src) &&
                      /if\s*\(\s*(IS_FUT|isFutures)\s*\)/.test(src);
    assert.ok((deltaOne && thetaZero) || futBranch,
      `${file} must either collapse δ→1 / θ→0 in futures mode, or price futures ` +
      `in a dedicated branch that skips the premium simulation`);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
section("Native live routes send the right product type on a REAL order");

// These place real broker orders directly (not through the paper-wrapping
// harness). A wrong isFutures here reaches the exchange: an option order sent
// as MARGIN, or a futures order sent as INTRADAY.
const liveRoutes = fs.readdirSync(ROUTES)
  .filter(f => /Live\.js$/.test(f))
  .sort();

check("the discovery found the native live routes", () => {
  assert.ok(liveRoutes.length >= 3, `expected native live routes, found ${liveRoutes.length}`);
});

for (const file of liveRoutes) {
  const src = decomment(read(path.join("routes", file)));
  check(`${file} never sends a hardcoded isFutures:false to the broker`, () => {
    const bad = /place(Market|SLM)Order\([^)]*isFutures:\s*false/.test(src);
    assert.ok(!bad,
      `${file} hardcodes isFutures:false on a broker call — a futures order would ` +
      `be sent as INTRADAY instead of MARGIN`);
  });
  check(`${file} resolves the instrument the toggle asks for`, () => {
    const seesToggle = /instrumentMode\.isFutures\(\)/.test(src) ||
                       /INSTRUMENT\s*===\s*["']NIFTY_FUTURES["']/.test(src);
    assert.ok(seesToggle, `${file} never tests INSTRUMENT before placing an order`);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
section("Live harnesses pass the real product type to the broker");

const harnesses = fs.readdirSync(ROUTES).filter(f => /LiveHarness\.js$/.test(f)).sort();

check("the discovery found the live harnesses", () => {
  assert.ok(harnesses.length >= 8, `expected the harnesses, found ${harnesses.length}`);
});

for (const file of harnesses) {
  const src = decomment(read(path.join("routes", file)));
  check(`${file} derives isFutures from the toggle`, () => {
    const m = src.match(/isFutures:\s*([^\n]+)/);
    assert.ok(m, `${file} passes no isFutures to installHarness`);
    const expr = m[1];
    if (/^\s*false\s*,?\s*$/.test(expr)) {
      // A hardcoded false is only acceptable for a declared opt-out, and the
      // reason must be written down next to it in the source.
      const raw = read(path.join("routes", file));
      assert.ok(/premium-denominated|no futures form|premium levels/i.test(raw),
        `${file} hardcodes isFutures:false with no documented reason — the broker ` +
        `would get INTRADAY for a futures order that needs MARGIN`);
    } else {
      assert.ok(/NIFTY_FUTURES/.test(expr),
        `${file} passes "${expr.trim()}" — it must consult INSTRUMENT`);
    }
  });
}

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

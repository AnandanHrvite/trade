#!/usr/bin/env node
/**
 * CROSS-STRATEGY PAPER ↔ LIVE PARITY INVARIANTS
 *
 *   node tests/liveParity.regression.js
 *
 * Zero dependencies, zero framework, exits non-zero on failure. Pure source
 * analysis — nothing here starts a socket, a broker or a session.
 *
 * Paper is the canonical implementation (see CLAUDE.md). Each standalone `*Live.js`
 * route is a HAND-WRITTEN mirror of its paper counterpart, which is exactly why they
 * drift: a gate added to paper does not automatically appear in live, and nothing in
 * the language catches it. Every assertion below pinned a real defect found on
 * 2026-07-26, in ORB first and then in the other three live routes.
 *
 * The harness routes (`*LiveHarness.js`) are deliberately NOT covered: they execute
 * their paper route directly, so they are parity-by-construction and have no second
 * copy of the logic to drift.
 */

const assert = require("assert");
const fs     = require("fs");
const path   = require("path");

const ROUTES = path.join(__dirname, "../src/routes");
const read   = (f) => fs.readFileSync(path.join(ROUTES, f), "utf-8");

// Standalone live routes and the paper route each one must mirror.
const PAIRS = [
  { live: "orbLive.js",       paper: "orbPaper.js",       label: "ORB" },
  { live: "bbRsiLive.js",     paper: "bbRsiPaper.js",     label: "BB_RSI" },
  { live: "paLive.js",        paper: "paPaper.js",        label: "PA" },
  { live: "emaRsiStLive.js",  paper: "emaRsiStPaper.js",  label: "EMA_RSI_ST" },
];

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); pass++; }
  catch (e) { console.log(`  ❌ ${name}\n       ${e.message}`); fail++; }
}

// Prose that merely mentions a call is not a call.
const decomment = (s) => s.split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

console.log("\nPortfolio-wide risk cap");

// The cross-strategy daily loss cap blocks new entries once the whole book is down
// by PORTFOLIO_MAX_DAILY_LOSS. It was added to the six paper routes and to none of
// the live ones, so an armed cap stopped paper entering while live — the side with
// real money — kept trading. Block-only; it can never place or alter an order.
for (const { live, paper, label } of PAIRS) {
  check(`${label}: live applies the portfolio cap, like paper does`, () => {
    assert.ok(/checkPortfolioCap/.test(read(paper)), `${paper} lost the portfolio cap — fix paper first, it is canonical`);
    assert.ok(/checkPortfolioCap/.test(read(live)),
      `${live} never checks the portfolio cap: with PORTFOLIO_MAX_DAILY_LOSS armed, paper stops entering and live keeps trading real money`);
  });
}

console.log("\nSession teardown must not race the broker");

// Paper's exit is synchronous, so its trade is in sessionTrades and sessionPnl is
// final before any bookkeeping runs. A live exit is a broker round-trip. Firing it
// un-awaited let stopSession run straight on to the session save / day report while
// the sell was still in flight, persisting a session missing its final trade — and
// when that was the day's only trade, the "any trades?" guard was false and the
// whole session was never saved. Real money, silently absent from the books.
const SAVE_CALL = /save\w*Session\(|saveData\(|\.sessions\.push\(/;

for (const { live, label } of PAIRS) {
  check(`${label}: live stopSession is async`, () => {
    const src = read(live);
    assert.ok(/async function stopSession/.test(src),
      `${live}: stopSession is synchronous, so it cannot await the broker square-off`);
  });

  check(`${label}: live stopSession awaits the exit BEFORE any bookkeeping`, () => {
    const src = read(live);
    const i = src.indexOf("async function stopSession");
    if (i < 0) throw new Error(`${live}: stopSession is not async (covered by the previous assertion)`);
    const body = src.slice(i, src.indexOf("\n}", i));
    const exit = body.search(/await\s+(squareOff|placeLiveSell)\(/);
    assert.ok(exit >= 0, `${live}: stopSession does not await its square-off`);

    const save = body.search(SAVE_CALL);
    if (save >= 0) {
      assert.ok(exit < save, `${live}: the session is saved before the exit completes — the final trade and its P&L are lost`);
    }
    const report = body.indexOf("notifyDayReport");
    if (report >= 0) {
      assert.ok(exit < report, `${live}: the day report is sent before the exit completes — it under-reports the day`);
    }
  });
}

console.log("\nNo unobserved exit promises");

// An un-awaited stopSession() is how a failed square-off becomes silent: the caller
// moves on, the rejection is never handled, and on shutdown the process can exit
// with a real position still open — the exact failure stopSession exists to prevent.
check("every caller of a live stopSession awaits or catches it", () => {
  const files = [...PAIRS.map(p => p.live), "../app.js"];
  for (const f of files) {
    const raw = f === "../app.js" ? fs.readFileSync(path.join(ROUTES, "../app.js"), "utf-8") : read(f);
    const src = decomment(raw);
    const re = /stopSession\(/g;
    let m;
    while ((m = re.exec(src))) {
      const ctx = src.slice(Math.max(0, m.index - 30), m.index + 60);
      if (/function stopSession/.test(ctx)) continue;              // the declaration
      if (/typeof\s+\w*\.?stopSession/.test(ctx)) continue;        // a capability probe
      assert.ok(/await\s+(?:\w+\.)?stopSession\(|stopSession\([^)]*\)\s*\.(catch|then)/.test(ctx),
        `${f}: stopSession() called without await/.catch — "${ctx.replace(/\s+/g, " ").trim()}"`);
    }
  }
});

console.log("\nEntry-gate surface");

// A gate present in one mode and absent in the other means the two take different
// trades on the same data. These are the shared, non-strategy-specific gates.
for (const { live, paper, label } of PAIRS) {
  check(`${label}: live honours the same shared entry gates as paper`, () => {
    const L = read(live), P = read(paper);
    for (const gate of ["_dailyLossHit|MAX_DAILY_LOSS", "checkPortfolioCap"]) {
      const re = new RegExp(gate);
      if (re.test(P)) assert.ok(re.test(L), `${live} is missing the "${gate}" gate that ${paper} applies`);
    }
  });
}

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

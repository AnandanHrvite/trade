#!/usr/bin/env node
/**
 * CROSS-STRATEGY PAPER INVARIANTS (formerly paper ↔ live parity)
 *
 *   node tests/liveParity.regression.js
 *
 * Zero dependencies, zero framework, exits non-zero on failure. Pure source
 * analysis — nothing here starts a socket, a broker or a session.
 *
 * All Live and Live Harness routes were removed; the live-side halves of these
 * checks went with them. What remains are the paper-side invariants they leaned
 * on: paper is canonical (see CLAUDE.md), so it must keep the shared entry gates,
 * and the shutdown path must never leave a paper stopSession() unobserved. The
 * file name is kept because package.json (`test`, `test:parity`) references it.
 */

const assert = require("assert");
const fs     = require("fs");
const path   = require("path");

const ROUTES = path.join(__dirname, "../src/routes");
const read   = (f) => fs.readFileSync(path.join(ROUTES, f), "utf-8");

const PAPERS = [
  { paper: "orbPaper.js",       label: "ORB" },
  { paper: "bbRsiPaper.js",     label: "BB_RSI" },
  { paper: "paPaper.js",        label: "PA" },
  { paper: "emaRsiStPaper.js",  label: "EMA_RSI_ST" },
];

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); pass++; }
  catch (e) { console.log(`  ❌ ${name}\n       ${e.message}`); fail++; }
}

// Prose that merely mentions a call is not a call.
const decomment = (s) => s.split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

console.log("\nShared entry gates (paper is canonical)");

// The cross-strategy daily loss cap blocks new entries once the whole book is down
// by PORTFOLIO_MAX_DAILY_LOSS. Block-only; it can never place or alter an order.
for (const { paper, label } of PAPERS) {
  check(`${label}: paper applies the portfolio cap`, () => {
    assert.ok(/checkPortfolioCap/.test(read(paper)), `${paper} lost the portfolio cap`);
  });
}

console.log("\nNo unobserved stopSession promises");

// An un-awaited stopSession() on shutdown lets process.exit fire before the
// session (and its final trade) is saved.
check("every stopSession() caller in app.js awaits or catches it", () => {
  const src = decomment(fs.readFileSync(path.join(ROUTES, "../app.js"), "utf-8"));
  const re = /stopSession\(/g;
  let m;
  while ((m = re.exec(src))) {
    const ctx = src.slice(Math.max(0, m.index - 30), m.index + 60);
    if (/function stopSession/.test(ctx)) continue;              // a declaration
    if (/typeof\s+\w*\.?stopSession/.test(ctx)) continue;        // a capability probe
    assert.ok(/await\s+(?:\w+\.)?stopSession\(|stopSession\([^)]*\)\s*\.(catch|then)/.test(ctx),
      `app.js: stopSession() called without await/.catch — "${ctx.replace(/\s+/g, " ").trim()}"`);
  }
});

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

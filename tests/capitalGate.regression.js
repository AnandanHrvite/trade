/**
 * capitalGate.regression.js — the paper capital pool is a HARD entry gate.
 * ─────────────────────────────────────────────────────────────────────────────
 * Run: node tests/capitalGate.regression.js
 *
 * The pool (utils/capitalPool.js) used to be advisory: an entry it could not
 * fund was taken anyway and the balance went negative. It now refuses the entry.
 * These checks pin that down in two layers:
 *
 *   1. Behaviour — gate() refuses a shortfall, mutes repeats, passes an
 *      affordable entry, and still fails OPEN on replay/sim, the toggle, and on
 *      unknown cost/strategy (an accounting error must never halt the book).
 *      Blocks are per position: single-position engines replace, EarlyBird adds.
 *   2. Wiring — every paper route that blocks capital is in the pool's strategy
 *      table (a missing row makes gate/block silent no-ops — TREND_DAY_SCALP
 *      shipped that way), runs gate() before opening the position, skip-logs the
 *      refusal and RETURNS, and frees its block on exit.
 * ─────────────────────────────────────────────────────────────────────────────
 */
const assert = require("assert");
const fs     = require("fs");
const path   = require("path");

const QUEUE = [];
function check(name, fn) { QUEUE.push({ name, fn }); }
const read = (rel) => fs.readFileSync(path.join(__dirname, "../src", rel), "utf8");

// ── 1. Behaviour ─────────────────────────────────────────────────────────────
// The pool derives realized P&L from ~/trading-data/*_paper_trades.json. Point
// HOME at an empty scratch dir BEFORE the module loads so the developer's real
// history can never change a verdict here.
process.env.HOME = fs.mkdtempSync(path.join(require("os").tmpdir(), "capital-gate-"));
process.env.FYERS_INV_AMOUNT = "1000";
process.env.ZERODHA_INV_AMOUNT = "1000";
process.env.PAPER_CAPITAL_GATE_ENABLED = "true";
const pool = require("../src/utils/capitalPool");
const errs = [];
const _origErr = console.error;
const quiet = (fn) => { console.error = (m) => errs.push(String(m)); try { return fn(); } finally { console.error = _origErr; } };

check("a shortfall is REFUSED, logged as an error once, and raised on the dashboard", () => {
  const r = quiet(() => pool.gate("orb", 65 * 200, { side: "CE", symbol: "NSE:NIFTY-CE", qty: 65 }));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.muted, false);
  assert.ok(/needs ₹13000 for 65 qty/.test(r.reason), r.reason);
  assert.strictEqual(errs.length, 1);
  assert.ok(/\[CAPITAL\] ORB entry REFUSED \(CE NSE:NIFTY-CE\)/.test(errs[0]), errs[0]);
  assert.strictEqual(pool.getAlerts().filter(a => a.key === "orb").length, 1);
});
check("a repeat within the mute window is still refused but not re-logged", () => {
  const before = errs.length;
  const r = quiet(() => pool.gate("orb", 65 * 200, { qty: 65 }));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.muted, true);
  assert.strictEqual(errs.length, before);
  assert.strictEqual(pool.getAlerts().filter(a => a.key === "orb").length, 1);
});
check("one strategy's mute does not silence another", () => {
  const before = errs.length;
  const r = quiet(() => pool.gate("pa", 65 * 200, { qty: 65 }));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.muted, false);
  assert.strictEqual(errs.length, before + 1);
});
check("an affordable entry passes", () => {
  const r = pool.gate("bb_rsi", 500, { qty: 5 });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.disabled, false);
});
check("replay / sim bypasses the gate", () => {
  const r = pool.gate("orb", 1e9, { qty: 65 }, { sim: true });
  assert.strictEqual(r.ok, true); assert.strictEqual(r.disabled, true);
});
check("the toggle OFF bypasses the gate", () => {
  process.env.PAPER_CAPITAL_GATE_ENABLED = "false";
  try { const r = pool.gate("orb", 1e9, { qty: 65 }); assert.strictEqual(r.ok, true); assert.strictEqual(r.disabled, true); }
  finally { process.env.PAPER_CAPITAL_GATE_ENABLED = "true"; }
});
check("unknown cost or strategy fails OPEN and never throws", () => {
  assert.strictEqual(pool.gate("orb", NaN, { qty: 65 }).ok, true);
  assert.strictEqual(pool.gate("orb", 0).ok, true);
  assert.strictEqual(pool.gate("no_such_strategy", 1e9).ok, true);
});
check("a single-position engine's block REPLACES the previous one and release frees it", () => {
  pool.clear("trend_pb");
  pool.block("trend_pb", 300, { symbol: "A" });
  pool.block("trend_pb", 400, { symbol: "B" });
  assert.strictEqual(pool.snapshot().fyers.positions.filter(p => p.key === "trend_pb").length, 1);
  assert.strictEqual(pool.snapshot().fyers.positions.find(p => p.key === "trend_pb").blocked, 400);
  pool.updateBlock("trend_pb", 450);
  assert.strictEqual(pool.snapshot().fyers.positions.find(p => p.key === "trend_pb").blocked, 450);
  pool.release("trend_pb", 0);
  assert.strictEqual(pool.snapshot().fyers.positions.filter(p => p.key === "trend_pb").length, 0);
});
check("a multi-position engine's blocks ADD UP and release frees only that symbol", () => {
  pool.clear("early_bird");
  pool.block("early_bird", 300, { symbol: "X" }, { add: true });
  pool.block("early_bird", 200, { symbol: "Y" }, { add: true });
  const eb = () => pool.snapshot().fyers.positions.filter(p => p.key === "early_bird");
  assert.strictEqual(eb().length, 2);
  assert.strictEqual(eb().reduce((t, p) => t + p.blocked, 0), 500);
  pool.release("early_bird", 0, { symbol: "X" });
  assert.deepStrictEqual(eb().map(p => p.symbol), ["Y"]);
  pool.release("early_bird", 0, { symbol: "not-blocked" });   // no-op, must not free Y
  assert.strictEqual(eb().length, 1);
  pool.clear("early_bird");
  assert.strictEqual(eb().length, 0);
});
check("blocked capital reduces what the gate will fund", () => {
  pool.clear("bb_rsi"); pool.clear("pa"); pool.clear("orb"); pool.clear("trend_pb"); pool.clear("early_bird");
  pool.clear("trend_day_scalp"); pool.clear("ha_scalp");
  const free = pool.snapshot().fyers.available;
  assert.ok(pool.gate("orb", free, { qty: 1 }).ok, "exactly the free amount must pass");
  pool.block("pa", 1);
  assert.strictEqual(pool.gate("trend_pb", free, { qty: 1 }).ok, false, "₹1 blocked by PA must refuse an entry that needed all of it");
  pool.clear("pa");
});

// ── 2. Wiring ────────────────────────────────────────────────────────────────
const POOL_SRC = read("utils/capitalPool.js");
const tableKeys = new Set([...POOL_SRC.matchAll(/^\s+([a-z0-9_]+):\s*\{ broker:/gm)].map(m => m[1]));

// Every paper route that reserves capital, with the key it uses.
const routesDir = path.join(__dirname, "../src/routes");
const paperRoutes = fs.readdirSync(routesDir).filter(f => /Paper\.js$/.test(f))
  .map(f => ({ file: f, src: fs.readFileSync(path.join(routesDir, f), "utf8") }))
  .filter(r => /capitalPool\.block\(/.test(r.src));
function keyOf(r) {
  const lit = r.src.match(/capitalPool\.gate\("([a-z0-9_]+)"/);
  if (lit) return lit[1];
  const mk = r.src.match(/^const MODE_KEY\s*=\s*"([a-z0-9_]+)"/m);
  return mk ? mk[1] : null;
}

check("at least the known paper engines reserve capital (the scan is not empty)", () => {
  assert.ok(paperRoutes.length >= 14, `only ${paperRoutes.length} paper routes call capitalPool.block`);
});

for (const r of paperRoutes) {
  const key = keyOf(r);
  check(`${r.file}: its pool key is in the strategy table`, () => {
    assert.ok(key, `cannot tell which pool key ${r.file} uses`);
    assert.ok(tableKeys.has(key), `"${key}" is not a row in capitalPool.STRATEGIES — gate/block are silent no-ops`);
  });
  check(`${r.file}: runs the HARD gate and returns on refusal, before blocking`, () => {
    assert.ok(!/capitalPool\.check\(/.test(r.src), "still calls the advisory check()");
    assert.ok(!/taken anyway/.test(r.src), "still enters when the pool cannot fund the trade");
    const gates = [...r.src.matchAll(/capitalPool\.gate\(/g)].map(m => m.index);
    assert.ok(gates.length >= 1, "no capitalPool.gate() call");
    for (const i of gates) {
      const after = r.src.slice(i, i + 1400);
      const blockAt = after.indexOf("capitalPool.block(");
      const win = blockAt > 0 ? after.slice(0, blockAt) : after;
      assert.ok(/if \(!_cap\.ok\) \{/.test(win), "gate result is not checked");
      assert.ok(/gate: "capital"/.test(win), "refusal is not skip-logged as gate:\"capital\"");
      assert.ok(/gate: "capital"[\s\S]*?\n\s+return;\n\s+\}/.test(win), "refusal does not return before the position is opened");
    }
  });
  check(`${r.file}: frees its block on exit`, () => {
    assert.ok(/capitalPool\.release\(/.test(r.src), "blocks capital but never releases it");
  });
}

check("EarlyBird blocks additively per symbol and releases per symbol", () => {
  const src = read("routes/earlyBirdPaper.js");
  const blocks = [...src.matchAll(/capitalPool\.block\([^\n]*\)/g)].map(m => m[0]);
  assert.ok(blocks.length >= 2 && blocks.every(b => /\{ add: true \}/.test(b)), "an EarlyBird block would overwrite its other positions' blocks");
  const rels = [...src.matchAll(/capitalPool\.release\([^\n]*\)/g)].map(m => m[0]);
  assert.ok(rels.length >= 2 && rels.every(b => /symbol:/.test(b)), "an EarlyBird release would free every other position's block");
});

check("the settings and dashboard no longer say the pool never stops a trade", () => {
  assert.ok(!/never stops a trade/i.test(read("routes/settings.js")));
  assert.ok(!/trades are still running|Nothing was stopped/.test(read("routes/realtime.js")));
});

// ── Runner ───────────────────────────────────────────────────────────────────
(async () => {
  let pass = 0, fail = 0;
  for (const { name, fn } of QUEUE) {
    try { await fn(); pass++; console.log(`  ✅ ${name}`); }
    catch (e) { fail++; console.log(`  ❌ ${name}\n       ${e.message.split("\n")[0]}`); }
  }
  console.log(fail ? `FAILURES — ${pass} passed, ${fail} failed` : `ALL PASS — ${pass} passed, 0 failed`);
  process.exit(fail ? 1 : 0);
})();

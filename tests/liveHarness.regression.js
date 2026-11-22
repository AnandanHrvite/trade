#!/usr/bin/env node
/**
 * LIVE / LIVE HARNESS — ORDER-PATH INVARIANTS
 *
 *   node tests/liveHarness.regression.js
 *
 * services/liveHarness.js turns a paper engine's notifyEntry / notifyExit into
 * orders. Every case here is a way to lose real money if it regresses: a SELL
 * without a proven BUY, an order with a switch off, a second entry after an
 * unknown outcome, a Harness that reaches Fyers. Fyers is a fake; HOME is a
 * temp dir so nothing touches ~/trading-data.
 */

process.env.TZ = process.env.TZ || "Asia/Calcutta";
const assert = require("assert");
const fs     = require("fs");
const os     = require("os");
const path   = require("path");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "live-harness-test-"));
process.env.HOME = TMP;
// Set (not deleted): modules loaded later call dotenv, which never overrides a
// key that already exists — so the real .env can't arm Telegram or a switch here.
for (const k of ["LIVE_TRADING_ENABLED", "HA_SCALP_REAL_ORDERS_ENABLED", "TEST_REAL_ORDERS_ENABLED", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"]) process.env[k] = "";
process.env.LIVE_BROKER_TIMEOUT_MS = "1500";

// ── Fake Fyers ───────────────────────────────────────────────────────────────
const fake = {
  calls: [], orders: [], net: new Map(), auth: true,
  placeImpl: null,              // optional override (symbol, side, qty) → result
  reset() { this.calls = []; this.orders = []; this.net = new Map(); this.auth = true; this.placeImpl = null; this.emptyBook = false; },
  isAuthenticated() { return this.auth; },
  async placeMarketOrder(symbol, side, qty, tag, opts) {
    this.calls.push({ symbol, side, qty, tag, opts });
    if (this.placeImpl) return this.placeImpl(symbol, side, qty);
    const id = `F${this.calls.length}`;
    this.orders.push({ id, symbol, status: 2, filledQty: qty, tradedPrice: side === 1 ? 100 : 110 });
    this.net.set(symbol, (this.net.get(symbol) || 0) + side * qty);
    return { success: true, orderId: id, raw: { s: "ok" } };
  },
  async getOrders() { return this.orders.slice(); },
  async getPositions() {
    if (this.emptyBook) return { netPositions: [] };
    return { netPositions: [...this.net.entries()].map(([symbol, netQty]) => ({ symbol, netQty })) };
  },
};
const brokerPath = require.resolve("../src/services/fyersBroker");
require.cache[brokerPath] = { id: brokerPath, filename: brokerPath, loaded: true, exports: fake };

const notify = require("../src/utils/notify");
const lh     = require("../src/services/liveHarness");
const POS_FILE = path.join(TMP, "trading-data", ".live_real_positions.json");

let pass = 0, fail = 0;
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const TAG = "TEST-PAPER";
const entry = (o = {}) => notify.notifyEntry({ mode: TAG, side: "CE", symbol: "NSE:NIFTY25DEC24500CE", qty: 75, optionEntryLtp: 99, ...o });
const exit  = (o = {}) => notify.notifyExit({ mode: TAG, side: "CE", symbol: "NSE:NIFTY25DEC24500CE", qty: 75, optionExitLtp: 111, pnl: 900, exitReason: "lock", ...o });
const ev = (mode) => lh.recentEvents(mode, 500).map((e) => e.event);
function arm(on) { process.env.LIVE_TRADING_ENABLED = on ? "true" : "false"; process.env.TEST_REAL_ORDERS_ENABLED = on ? "true" : "false"; }
function fresh(mode) { lh.uninstall(mode); fake.reset(); try { fs.unlinkSync(POS_FILE); } catch (_) {} }
const LIVE = "TEST-LIVE", HARN = "TEST-HARNESS";
const installLive = (extra = {}) => lh.install({ mode: LIVE, modeTag: TAG, envPrefix: "TEST", dryRun: false, isFutures: () => false, ...extra });

// ── Harness never reaches Fyers ─────────────────────────────────────────────
test("Harness: full entry→exit on the simulator, zero Fyers calls", async () => {
  fresh(HARN); arm(true);
  lh.install({ mode: HARN, modeTag: TAG, envPrefix: "TEST", dryRun: true, isFutures: () => false });
  entry(); await tick(50); exit(); await tick(50);
  assert.strictEqual(fake.calls.length, 0, "harness must never call Fyers");
  const e = ev(HARN);
  assert.ok(e.includes("ENTRY_FILLED") && e.includes("EXIT_FILLED"), e.join(","));
  assert.strictEqual(lh.status(HARN).positions.length, 0);
  assert.ok(!fs.existsSync(POS_FILE) || Object.keys(JSON.parse(fs.readFileSync(POS_FILE, "utf8"))).length === 0, "sim positions never persisted");
  lh.uninstall(HARN);
});

// ── Switches ────────────────────────────────────────────────────────────────
test("Live: either switch OFF → no order placed", async () => {
  for (const [g, s] of [["false", "true"], ["true", "false"], ["false", "false"]]) {
    fresh(LIVE); process.env.LIVE_TRADING_ENABLED = g; process.env.TEST_REAL_ORDERS_ENABLED = s;
    installLive(); entry(); await tick(30); exit(); await tick(30);
    assert.strictEqual(fake.calls.length, 0, `global=${g} strategy=${s}`);
    assert.ok(ev(LIVE).includes("ENTRY_SKIPPED_SWITCH_OFF"));
  }
  lh.uninstall(LIVE);
});
test("Live: switch turned OFF mid-trade still lets the exit go out", async () => {
  fresh(LIVE); arm(true); installLive();
  entry(); await tick(50);
  arm(false); exit(); await tick(50);
  assert.deepStrictEqual(fake.calls.map((c) => c.side), [1, -1]);
  lh.uninstall(LIVE);
});

// ── Happy path + persistence ────────────────────────────────────────────────
test("Live: BUY filled → recorded on disk → SELL closes it → disk cleared", async () => {
  fresh(LIVE); arm(true); installLive();
  entry(); await tick(50);
  assert.strictEqual(fake.calls[0].side, 1);
  const disk = Object.values(JSON.parse(fs.readFileSync(POS_FILE, "utf8")));
  assert.strictEqual(disk.length, 1); assert.strictEqual(disk[0].qty, 75);
  exit(); await tick(50);
  assert.strictEqual(fake.calls[1].side, -1); assert.strictEqual(fake.calls[1].qty, 75);
  assert.strictEqual(Object.keys(JSON.parse(fs.readFileSync(POS_FILE, "utf8"))).length, 0);
  const x = lh.recentEvents(LIVE).filter((e) => e.event === "EXIT_FILLED").pop();
  assert.strictEqual(x.realGrossPnl, 750);   // (110 − 100) × 75
  lh.uninstall(LIVE);
});
test("Other modes' notify calls are ignored", async () => {
  fresh(LIVE); arm(true); installLive();
  notify.notifyEntry({ mode: "OTHER-PAPER", side: "CE", symbol: "X", qty: 75 }); await tick(30);
  assert.strictEqual(fake.calls.length, 0);
  lh.uninstall(LIVE);
});

// ── Never a naked SELL ──────────────────────────────────────────────────────
test("Live: rejected BUY → paper exit sends NOTHING", async () => {
  fresh(LIVE); arm(true); installLive();
  fake.placeImpl = () => ({ success: false, orderId: null, raw: { message: "RMS reject" } });
  entry(); await tick(50); fake.placeImpl = null; exit(); await tick(50);
  assert.strictEqual(fake.calls.length, 1, "only the rejected BUY");
  assert.ok(ev(LIVE).includes("EXIT_SKIPPED_NO_POSITION"));
  lh.uninstall(LIVE);
});
test("Live: accepted-then-rejected BUY is not a position", async () => {
  fresh(LIVE); arm(true); installLive();
  fake.placeImpl = (symbol) => { fake.orders.push({ id: "R1", symbol, status: 5, filledQty: 0, message: "margin" }); return { success: true, orderId: "R1" }; };
  entry(); await tick(50); fake.placeImpl = null; exit(); await tick(50);
  assert.strictEqual(fake.calls.length, 1);
  assert.ok(ev(LIVE).includes("ENTRY_REJECTED_AFTER_ACCEPT"));
  lh.uninstall(LIVE);
});
test("Live: broker shows FLAT → no SELL sent", async () => {
  fresh(LIVE); arm(true); installLive();
  entry(); await tick(50);
  fake.net.set("NSE:NIFTY25DEC24500CE", 0); fake.net.set("NSE:OTHER", 50);   // closed elsewhere
  exit(); await tick(50);
  assert.strictEqual(fake.calls.length, 1);
  assert.ok(ev(LIVE).includes("EXIT_ALREADY_FLAT"));
  lh.uninstall(LIVE);
});

// ── Unknown outcome blocks re-entry ─────────────────────────────────────────
test("Live: unknown-outcome BUY blocks new entries until cleared", async () => {
  fresh(LIVE); arm(true); installLive();
  fake.placeImpl = () => ({ success: false, uncertain: true, orderId: null, raw: { error: "ETIMEDOUT" } });
  entry(); await tick(50);
  assert.ok(lh.status(LIVE).blocked);
  fake.placeImpl = null;
  entry({ symbol: "NSE:NIFTY25DEC24600CE" }); await tick(50);
  assert.strictEqual(fake.calls.length, 1, "second entry must be blocked");
  assert.ok(ev(LIVE).includes("ENTRY_BLOCKED_UNCONFIRMED"));
  // Unconfirmed record + unreadable book → never closed blind.
  fake.emptyBook = true; exit(); await tick(50);
  assert.strictEqual(fake.calls.length, 1);
  assert.ok(ev(LIVE).includes("EXIT_UNVERIFIED"));
  assert.ok(lh.clearBlock(LIVE)); assert.ok(!lh.status(LIVE).blocked);
  // The unverified record survives until Fyers proves the account flat.
  assert.strictEqual(lh.status(LIVE).positions.length, 1);
  fake.emptyBook = false; fake.net.set("NSE:OTHER", 50);
  assert.strictEqual(await lh.squareOff(LIVE), 0);
  assert.strictEqual(fake.calls.length, 1, "flat → no SELL");
  lh.uninstall(LIVE);
});

// ── Races ───────────────────────────────────────────────────────────────────
test("Live: exit fired while the BUY is in flight waits, then closes", async () => {
  fresh(LIVE); arm(true); installLive();
  let release; const gate = new Promise((r) => { release = r; });
  fake.placeImpl = async (symbol, side, qty) => {
    if (side === 1) await gate;
    fake.placeImpl = null;
    return fake.placeMarketOrder(symbol, side, qty);
  };
  entry(); exit(); await tick(20);
  release(); await tick(100);
  const sides = fake.calls.filter((c) => !c.tag || c.tag).map((c) => c.side);
  assert.ok(sides.includes(1) && sides.includes(-1), `got ${sides}`);
  assert.strictEqual(lh.status(LIVE).positions.length, 0);
  lh.uninstall(LIVE);
});
test("Live: duplicate entry on the same symbol is skipped", async () => {
  fresh(LIVE); arm(true); installLive();
  entry(); entry(); await tick(50);
  assert.strictEqual(fake.calls.length, 1);
  exit(); await tick(50);
  assert.strictEqual(lh.status(LIVE).positions.length, 0);
  lh.uninstall(LIVE);
});

test("Live Stop: detach first, then square-off waits for an in-flight BUY and closes it", async () => {
  fresh(LIVE); arm(true); installLive();
  let release; const gate = new Promise((r) => { release = r; });
  fake.placeImpl = async (symbol, side, qty) => {
    if (side === 1) await gate;
    fake.placeImpl = null;
    return fake.placeMarketOrder(symbol, side, qty);
  };
  entry(); await tick(10);
  lh.uninstall(LIVE);                     // what the Stop button does first
  entry({ symbol: "NSE:NIFTY25DEC24700CE" }); await tick(10);   // after detach → ignored
  const sq = lh.squareOff(LIVE);
  release();
  assert.strictEqual(await sq, 0);
  // (the gated fake logs the BUY call twice — judge by the broker book instead)
  assert.strictEqual(fake.net.get("NSE:NIFTY25DEC24500CE"), 0, "bought then sold back to flat");
  assert.ok(!fake.net.has("NSE:NIFTY25DEC24700CE"), "entry after detach never reached Fyers");
  assert.strictEqual(fake.calls.filter((c) => c.side === -1).length, 1);
});

// ── Futures direction ───────────────────────────────────────────────────────
test("Live futures: PE opens with SELL, closes with BUY", async () => {
  fresh(LIVE); arm(true); installLive({ isFutures: () => true });
  entry({ side: "PE", symbol: "NSE:NIFTY25DECFUT" }); await tick(50);
  exit({ side: "PE", symbol: "NSE:NIFTY25DECFUT" }); await tick(50);
  assert.deepStrictEqual(fake.calls.map((c) => c.side), [-1, 1]);
  lh.uninstall(LIVE);
});

// ── Lifecycle ───────────────────────────────────────────────────────────────
test("Live and Harness can't attach to the same paper engine", () => {
  fresh(LIVE); fresh(HARN); installLive();
  assert.throws(() => lh.install({ mode: HARN, modeTag: TAG, envPrefix: "TEST", dryRun: true }));
  lh.uninstall(LIVE);
});
test("Paper session end (day report) detaches", () => {
  fresh(LIVE); installLive();
  notify.notifyDayReport({ mode: TAG, sessionTrades: [], sessionPnl: 0 });
  assert.ok(!lh.isInstalled(LIVE));
});
test("Restart: a recorded real position is restored and only closed after Fyers confirms it", async () => {
  fresh(LIVE); arm(true); installLive();
  entry(); await tick(50);
  // Simulate a crash: drop memory, keep disk.
  lh.uninstall(LIVE);
  delete require.cache[require.resolve("../src/services/liveHarness")];
  const lh2 = require("../src/services/liveHarness");
  assert.strictEqual(lh2.persistedRealPositions(LIVE).length, 1);
  fake.emptyBook = true;
  assert.strictEqual(await lh2.squareOff(LIVE), 1, "unreadable book → stays open");
  assert.strictEqual(fake.calls.length, 1);
  fake.emptyBook = false;
  assert.strictEqual(await lh2.squareOff(LIVE), 0);
  assert.deepStrictEqual(fake.calls.map((c) => c.side), [1, -1]);
  assert.strictEqual(lh2.persistedRealPositions(LIVE).length, 0);
});

// ── Wiring: each Live page listens to its paper engine's real notify tag ─────
test("Wiring: Live / Harness modeTag matches the paper route's NOTIFY_MODE", () => {
  const SRC = path.join(__dirname, "../src");
  const read = (rel) => fs.readFileSync(path.join(SRC, rel), "utf8");
  const pages = fs.readdirSync(path.join(SRC, "routes")).filter((f) => /Live(Harness)?\.js$/.test(f));
  assert.ok(pages.length >= 2, "expected Live pages");
  const reg = require("../src/config/strategyRegistry");
  for (const f of pages) {
    const s = read(`routes/${f}`);
    const id = (s.match(/id:\s*"(\w+)"/) || [])[1];
    const tag = (s.match(/modeTag:\s*"([^"]+)"/) || [])[1];
    const e = reg.byId(id);
    assert.ok(e && tag, `${f}: id/modeTag`);
    const paper = read(`${e.paper.module}.js`);
    // The home (NIFTY) instance's notify tag: the literal before `: rt.notifyMode`, else rt.notifyMode itself.
    const decl = paper.match(/const (?:NOTIFY_MODE|MODE_TAG)\s*=\s*(?:rt\.home \? "([^"]+)" : )?rt\.notifyMode/);
    assert.ok(decl, `${f}: no NOTIFY_MODE / MODE_TAG declaration in ${e.paper.module}`);
    const homeTag = decl[1] || require("../src/utils/pairRuntime").forStrategy(id).notifyMode;
    assert.strictEqual(tag, homeTag, `${f}: modeTag ${tag} ≠ paper's ${homeTag}`);
    const app = read("app.js");
    assert.ok(app.includes(`require("./routes/${f.replace(/\.js$/, "")}")`), `${f} not mounted in app.js`);
    assert.ok(/lazyRouter\(\(\) => require\("\.\/routes\/\w+Live(Harness)?"\)\)/.test(app), "Live pages must be lazy (Start-All must never see them)");
    const prefix = e.envPrefix;
    if (/kind:\s*"live"/.test(s)) assert.ok(read("routes/settings.js").includes(`"${prefix}_REAL_ORDERS_ENABLED"`), `${prefix}_REAL_ORDERS_ENABLED missing from Settings`);
  }
});

(async () => {
  for (const t of queue) {
    try { await t.fn(); pass++; console.log(`  ✓ ${t.name}`); }
    catch (e) { fail++; console.log(`  ✗ ${t.name}\n      ${e.message}`); }
  }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  console.log(`\nliveHarness: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();

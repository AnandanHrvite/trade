#!/usr/bin/env node
/**
 * MARKETS — the market list + expiry layer (src/config/markets.js)
 *
 *   node tests/markets.regression.js
 *
 * Zero dependencies, exits non-zero on failure. No network: HOME points at a
 * temp dir first, so nseHolidays runs on its offline 2026 list (+ fixed-date
 * holidays for other years) and mcxContracts reads only the fixture master
 * written below. Every date is passed explicitly — nothing depends on today.
 *
 * Holidays used (NSE = BSE list, 2026): Tue 03-Mar Holi, Thu 15-Jan municipal
 * election, Thu 26-Mar Ram Navami, Tue 24-Nov Guru Nanak; 26-Jan (fixed).
 */

process.env.TZ = "Asia/Calcutta";
const os = require("os");
const fs = require("fs");
const path = require("path");
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "markets-test-"));
process.env.HOME = TMP_HOME;
process.env.USERPROFILE = TMP_HOME;

const assert = require("assert");
const instrument = require("../src/config/instrument");
const markets = require("../src/config/markets");

// instrument.js loads the repo .env on require — clear every key this suite
// reads so it runs on code defaults whatever the local .env holds.
const PREFIXES = ["NIFTY_", "BANKNIFTY_", "SENSEX_", "SAIL_", "FUT_", "CRUDE_", "GOLD_", "SILVER_", "CMX_", "STRIKE_OFFSET", "OPTION_EXPIRY_"];
for (const k of Object.keys(process.env)) if (PREFIXES.some((p) => k.startsWith(p))) delete process.env[k];

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; }
  catch (e) { failed++; console.error(`✗ ${name}\n    ${e.message}`); }
}
function withEnv(vars, fn) {
  const old = {};
  for (const k of Object.keys(vars)) { old[k] = process.env[k]; process.env[k] = vars[k]; }
  try { return fn(); }
  finally { for (const k of Object.keys(vars)) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; } }
}
const quiet = (fn) => { const l = console.log; console.log = () => {}; try { return fn(); } finally { console.log = l; } };
const exp = (key, date) => markets.expiryInfo(key, date);

// ── NIFTY — weekly Tuesday ──────────────────────────────────────────────────
test("NIFTY: weekly Tuesday, code YYMDD", () => {
  const i = exp("NIFTY", "2026-11-11");                 // Wed
  assert.deepStrictEqual([i.date, i.code, i.source], ["2026-11-17", "26N17", "rule"]);
  assert.strictEqual(markets.nextExpiry("NIFTY", "2026-11-17T10:00"), "2026-11-17");   // expiry day, session open
});
test("NIFTY: rolls at the 15:30 close; a Tuesday holiday preponed to Monday (monthly code)", () => {
  const i = exp("NIFTY", "2026-11-17T15:30");
  assert.deepStrictEqual([i.scheduled, i.date, i.code], ["2026-11-24", "2026-11-23", "26NOV"]);
  assert.strictEqual(markets.nextExpiry("NIFTY", "2026-11-23T15:29"), "2026-11-23");
  assert.strictEqual(markets.nextExpiry("NIFTY", "2026-11-23T15:30"), "2026-12-01");   // preponed session closed → next week
});
test("NIFTY: Holi (Tue 03-Mar-2026) weekly preponed to Mon 02-Mar, weekly code", () => {
  const i = exp("NIFTY", "2026-02-27");
  assert.deepStrictEqual([i.scheduled, i.date, i.code], ["2026-03-03", "2026-03-02", "26302"]);
});
test("NIFTY: last-Tuesday holiday (31-Mar-2026) → Mon 30-Mar, monthly code", () => {
  const i = exp("NIFTY", "2026-03-27");
  assert.deepStrictEqual([i.date, i.code], ["2026-03-30", "26MAR"]);
});
test("NIFTY: the pure expiry form matches the engines' now-based one", () => {
  assert.strictEqual(
    nseIso(instrument.weeklyExpiryAt(istNow(), "NIFTY")),
    nseIso(instrument.getNearestWeeklyExpiryDate()));
  assert.strictEqual(
    nseIso(instrument.monthlyExpiryAt(istNow(), "NIFTY")),
    nseIso(instrument.getNearestMonthlyExpiryDate()));
  assert.strictEqual(instrument.futuresContractAt(istNow()).code, instrument.getFuturesExpiry());
});

// ── SENSEX — weekly Thursday (BSE) ──────────────────────────────────────────
test("SENSEX: weekly Thursday (verified vs BSE_FO.csv: 12-Nov-2026 = SENSEX26N12…)", () => {
  const i = exp("SENSEX", "2026-11-11");
  assert.deepStrictEqual([i.date, i.code], ["2026-11-12", "26N12"]);
  assert.strictEqual(markets.nextExpiry("SENSEX", "2026-11-12T15:29"), "2026-11-12");
  assert.strictEqual(markets.nextExpiry("SENSEX", "2026-11-12T15:30"), "2026-11-19");
});
test("SENSEX: last Thursday is the monthly YYMMM contract (26-Nov-2026 = SENSEX26NOV…)", () => {
  const i = exp("SENSEX", "2026-11-20");
  assert.deepStrictEqual([i.date, i.code], ["2026-11-26", "26NOV"]);
  assert.strictEqual(exp("SENSEX", "2026-12-21").code, "26D24");        // 24-Dec is NOT the last Thursday
  assert.strictEqual(exp("SENSEX", "2026-12-25").code, "26DEC");        // 31-Dec is
});
test("SENSEX: Thursday holiday preponed to Wednesday", () => {
  const a = exp("SENSEX", "2026-01-12");                 // Thu 15-Jan holiday
  assert.deepStrictEqual([a.scheduled, a.date, a.code], ["2026-01-15", "2026-01-14", "26114"]);
  const b = exp("SENSEX", "2026-03-23");                 // Thu 26-Mar Ram Navami = last Thursday
  assert.deepStrictEqual([b.scheduled, b.date, b.code], ["2026-03-26", "2026-03-25", "26MAR"]);
  assert.strictEqual(markets.nextExpiry("SENSEX", "2026-03-25T15:30"), "2026-04-02");
});

// ── BANKNIFTY — monthly only ────────────────────────────────────────────────
test("BANKNIFTY: monthly last Tuesday only, preponed, rolls after the close", () => {
  const a = exp("BANKNIFTY", "2026-11-11");
  assert.deepStrictEqual([a.scheduled, a.date, a.code], ["2026-11-24", "2026-11-23", "26NOV"]);
  const b = exp("BANKNIFTY", "2026-11-23T15:30");
  assert.deepStrictEqual([b.date, b.code], ["2026-12-29", "26DEC"]);
  const c = exp("BANKNIFTY", "2026-12-30");              // Tue 26-Jan-2027 Republic Day
  assert.deepStrictEqual([c.scheduled, c.date, c.code], ["2027-01-26", "2027-01-25", "27JAN"]);
  assert.strictEqual(markets.get("BANKNIFTY").expiry.weekly, false);
});

// ── NIFTY futures + stocks ──────────────────────────────────────────────────
test("NIFTY_FUT: month contract, rolls two days before expiry", () => {
  assert.strictEqual(markets.optionSymbol("NIFTY_FUT", 25000, "CE", { date: "2026-11-11" }), "NSE:NIFTY26NOVFUT");
  assert.strictEqual(markets.nextExpiry("NIFTY_FUT", "2026-11-11"), "2026-11-23");
  assert.strictEqual(markets.optionSymbol("NIFTY_FUT", 25000, "PE", { date: "2026-11-23" }), "NSE:NIFTY26DECFUT");
  assert.strictEqual(markets.get("NIFTY_FUT").lotSize, instrument.underlyingOf("NIFTY").lotSize);
});
test("SAIL (stock): monthly last Tuesday, ₹2.5 grid", () => {
  assert.strictEqual(markets.nextExpiry("SAIL", "2026-11-11"), "2026-11-23");
  assert.strictEqual(quiet(() => markets.optionSymbol("SAIL", 168.6, "PE", { date: "2026-11-11" })), "NSE:SAIL26NOV167.5PE");
  assert.strictEqual(markets.get("SAIL").group, "stock");
});

// ── strike rounding + symbol strings ────────────────────────────────────────
test("strike rounding: SENSEX on 100, NIFTY on 50", () => {
  const s = (k, spot) => markets.optionSymbol(k, spot, "CE", { date: "2026-11-11", atm: true });
  assert.strictEqual(s("SENSEX", 76549), "BSE:SENSEX26N1276500CE");
  assert.strictEqual(s("SENSEX", 76550), "BSE:SENSEX26N1276600CE");
  assert.strictEqual(s("NIFTY", 24324), "NSE:NIFTY26N1724300CE");
  assert.strictEqual(s("NIFTY", 24325), "NSE:NIFTY26N1724350CE");
});
test("symbol strings: BSE weekly/monthly, NSE weekly/monthly, explicit strike/expiry", () => {
  assert.strictEqual(markets.optionSymbol("SENSEX", 76512, "PE", { date: "2026-11-20" }), "BSE:SENSEX26NOV76500PE");
  assert.strictEqual(markets.optionSymbol("NIFTY", 24310, "PE", { date: "2026-11-20" }), "NSE:NIFTY26NOV24300PE");
  assert.strictEqual(markets.optionSymbol("BANKNIFTY", 54321, "CE", { date: "2026-11-11" }), "NSE:BANKNIFTY26NOV54300CE");
  assert.strictEqual(markets.optionSymbol("SENSEX", 0, "CE", { expiry: "2026-12-03", strike: 72000 }), "BSE:SENSEX26D0372000CE");
  assert.throws(() => markets.optionSymbol("NIFTY", 24300, "XX"));
});
test("configured strike offsets apply unless opts.atm", () => {
  withEnv({ SENSEX_STRIKE_OFFSET_CE: "-100" }, () => {
    assert.strictEqual(quiet(() => markets.optionSymbol("SENSEX", 76510, "CE", { date: "2026-11-11" })), "BSE:SENSEX26N1276400CE");
    assert.strictEqual(markets.optionSymbol("SENSEX", 76510, "CE", { date: "2026-11-11", atm: true }), "BSE:SENSEX26N1276500CE");
  });
});

// ── manual override precedence ──────────────────────────────────────────────
test("override: a future date wins over the rule", () => {
  withEnv({ OPTION_EXPIRY_OVERRIDE: "2026-12-01" }, () => {
    const i = exp("NIFTY", "2026-11-11");
    assert.deepStrictEqual([i.date, i.source, i.code], ["2026-12-01", "override", "26D01"]);
    assert.strictEqual(markets.optionSymbol("NIFTY", 24300, "CE", { date: "2026-11-11" }), "NSE:NIFTY26D0124300CE");
  });
  withEnv({ SENSEX_OPTION_EXPIRY_OVERRIDE: "2026-11-19" }, () => {
    assert.strictEqual(markets.nextExpiry("SENSEX", "2026-11-11"), "2026-11-19");
    assert.strictEqual(markets.nextExpiry("NIFTY", "2026-11-11"), "2026-11-17");   // per market, not global
  });
  withEnv({ FUT_EXPIRY_OVERRIDE: "2026-12-29" }, () => {
    assert.strictEqual(markets.optionSymbol("NIFTY_FUT", 25000, "CE", { date: "2026-11-11" }), "NSE:NIFTY26DECFUT");
  });
});
test("override: live until its own session closes, then ignored (flagged stale)", () => {
  withEnv({ OPTION_EXPIRY_OVERRIDE: "2026-11-12" }, () => {
    assert.strictEqual(exp("NIFTY", "2026-11-12T15:29").source, "override");
    const i = exp("NIFTY", "2026-11-12T15:30");
    assert.deepStrictEqual([i.source, i.date, i.overrideStale], ["rule", "2026-11-17", true]);
  });
  withEnv({ OPTION_EXPIRY_OVERRIDE: "garbage" }, () => assert.strictEqual(exp("NIFTY", "2026-11-11").source, "rule"));
});
test("override: monthly expiry type names the month contract, as the engines do", () => {
  withEnv({ OPTION_EXPIRY_OVERRIDE: "2026-12-08", OPTION_EXPIRY_TYPE: "monthly" }, () => {
    assert.strictEqual(exp("NIFTY", "2026-11-11").code, "26DEC");
  });
});

// ── calendars + sessions ────────────────────────────────────────────────────
test("isTradingDay: NSE/BSE holidays + weekends; MCX weekdays", () => {
  assert.strictEqual(markets.isTradingDay("NIFTY", "2026-11-24"), false);
  assert.strictEqual(markets.isTradingDay("NIFTY", "2026-11-23"), true);
  assert.strictEqual(markets.isTradingDay("NIFTY", "2026-11-14"), false);   // Saturday
  assert.strictEqual(markets.isTradingDay("SENSEX", "2026-03-26"), false);
  assert.strictEqual(markets.isTradingDay("CRUDE", "2026-11-24"), true);    // MCX has no calendar here
  assert.strictEqual(markets.isTradingDay("CRUDE", "2026-11-15"), false);   // Sunday
});
test("session hours", () => {
  const n = markets.session("NIFTY"), s = markets.session("SENSEX"), c = markets.session("CRUDE");
  assert.deepStrictEqual([n.start, n.end, s.start, s.end, c.start, c.end], ["09:15", "15:30", "09:15", "15:30", "09:00", "23:30"]);
  assert.deepStrictEqual([c.startMin, c.endMin], [540, 1410]);
});

// ── the list itself ─────────────────────────────────────────────────────────
test("list(): every market, NIFTY first; unknown → NIFTY", () => {
  const keys = markets.list().map((m) => m.key);
  assert.deepStrictEqual(keys.slice(0, 7), ["NIFTY", "NIFTY_FUT", "BANKNIFTY", "SENSEX", "CRUDE", "GOLD", "SILVER"]);
  for (const k of Object.keys(instrument.STOCK_DEFS)) assert.ok(keys.includes(k), `stock ${k} listed`);
  assert.strictEqual(markets.get("nope").key, "NIFTY");
  assert.strictEqual(markets.get("bn").key, "BANKNIFTY");
});
test("env keys: NIFTY keeps the unprefixed originals; new markets are prefixed", () => {
  const n = markets.get("NIFTY").env;
  assert.deepStrictEqual([n.lotSize, n.strikeStep, n.expiryOverride], ["NIFTY_LOT_SIZE", "NIFTY_STRIKE_STEP", "OPTION_EXPIRY_OVERRIDE"]);
  const s = markets.get("SENSEX").env;
  assert.deepStrictEqual([s.lotSize, s.strikeStep, s.expiryOverride], ["SENSEX_LOT_SIZE", "SENSEX_STRIKE_STEP", "SENSEX_OPTION_EXPIRY_OVERRIDE"]);
  assert.strictEqual(markets.get("BANKNIFTY").env.expiryOverride, "BANKNIFTY_OPTION_EXPIRY_OVERRIDE");
  assert.strictEqual(markets.get("SAIL").env.lotSize, "SAIL_LOT_SIZE");
  assert.strictEqual(markets.get("NIFTY_FUT").env.expiryOverride, "FUT_EXPIRY_OVERRIDE");
  assert.deepStrictEqual(["CRUDE", "GOLD", "SILVER"].map((k) => markets.get(k).env.expiryOverride),
    ["CRUDE_OPTION_EXPIRY_OVERRIDE", "GOLD_OPTION_EXPIRY_OVERRIDE", "SILVER_OPTION_EXPIRY_OVERRIDE"]);
});
test("SENSEX row: BSE, grid 100, lot 20 (Settings-overridable)", () => {
  const m = markets.get("SENSEX");
  assert.deepStrictEqual([m.exchange, m.spot, m.strikeStep, m.lotSize, m.expiry.weekday], ["BSE", "BSE:SENSEX-INDEX", 100, 20, 4]);
  withEnv({ SENSEX_LOT_SIZE: "25" }, () => assert.strictEqual(markets.get("SENSEX").lotSize, 25));
});
test("SENSEX is registered, not traded: nothing that runs picks it up", () => {
  assert.deepStrictEqual(instrument.listUnderlyings().map((u) => u.key), ["NIFTY", "BANKNIFTY", "SAIL"]);
  assert.strictEqual(instrument.isUnderlyingEnabled("SENSEX"), false);
  assert.ok(instrument.listUnderlyings({ includeMarketOnly: true }).some((u) => u.key === "SENSEX"));
  assert.strictEqual(markets.get("SENSEX").traded, false);
});
test("NIFTY / BANKNIFTY instrument rows unchanged", () => {
  const n = instrument.underlyingOf("NIFTY"), b = instrument.underlyingOf("BANKNIFTY");
  assert.deepStrictEqual([n.spot, n.strikeStep, n.lotSize, n.weekly, n.expiryDow, n.exchange], ["NSE:NIFTY50-INDEX", 50, 65, true, 2, "NSE"]);
  assert.deepStrictEqual([b.spot, b.strikeStep, b.lotSize, b.weekly], ["NSE:NIFTYBANK-INDEX", 100, 30, false]);
  assert.strictEqual(instrument.expiryCodeFor(new Date(2026, 7, 25)), "26AUG");
  assert.strictEqual(instrument.expiryCodeFor(new Date(2026, 7, 18)), "26818");
  assert.strictEqual(instrument.underlyingOf("NIFTY_FUT").key, "NIFTY");
});

// ── MCX (fixture symbol master — no network) ────────────────────────────────
test("MCX: expiry + ATM option from the symbol master; mismatched override refuses", () => {
  const mcx = require("../src/services/mcxContracts");
  const sec = (ymd) => Math.floor(Date.parse(`${ymd}T23:30:00+05:30`) / 1000);
  const row = (sym, und, exp, strike, type, scrip, undScrip) => {
    const c = new Array(21).fill("");
    c[3] = "1"; c[8] = String(sec(exp)); c[9] = sym; c[12] = scrip; c[13] = und; c[14] = undScrip; c[15] = String(strike); c[16] = type;
    return c.join(",");
  };
  const lines = [
    row("MCX:CRUDEOIL26NOVFUT", "CRUDEOIL", "2026-11-19", -1, "XX", "F1", "0"),
    row("MCX:CRUDEOIL26DECFUT", "CRUDEOIL", "2026-12-18", -1, "XX", "F2", "0"),
  ];
  for (const k of [7850, 7900, 7950]) {
    for (const t of ["CE", "PE"]) {
      lines.push(row(`MCX:CRUDEOIL26NOV${k}${t}`, "CRUDEOIL", "2026-11-17", k, t, `N${k}${t}`, "F1"));
      lines.push(row(`MCX:CRUDEOIL26DEC${k}${t}`, "CRUDEOIL", "2026-12-16", k, t, `D${k}${t}`, "F2"));
    }
  }
  const dir = path.join(TMP_HOME, "trading-data", "cmx");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "MCX_COM.csv"), lines.join("\n") + "\n");
  assert.ok(mcx.peekSeries("CRUDEOIL"), "fixture master readable");

  const i = exp("CRUDE", "2026-11-11");
  assert.deepStrictEqual([i.date, i.source, i.future], ["2026-11-17", "master", "MCX:CRUDEOIL26NOVFUT"]);
  assert.strictEqual(markets.nextExpiry("CRUDE", "2026-11-17"), "2026-12-16");   // expiry day itself is never traded
  assert.strictEqual(markets.optionSymbol("CRUDE", 7912, "CE", { date: "2026-11-11" }), "MCX:CRUDEOIL26NOV7900CE");
  withEnv({ CRUDE_OPTION_EXPIRY_OVERRIDE: "2026-12-16" }, () => {
    assert.strictEqual(markets.nextExpiry("CRUDE", "2026-11-11"), "2026-12-16");
    assert.strictEqual(markets.optionSymbol("CRUDE", 7912, "CE", { date: "2026-11-11" }), null);
  });
  const m = markets.get("CRUDE");
  assert.deepStrictEqual([m.exchange, m.contract, m.lotSize, m.strikeStep], ["MCX", "CRUDEOIL", 100, 50]);
  assert.strictEqual(markets.nextExpiry("GOLD", "2026-11-11"), null);           // not in the fixture
});

function istNow() { const t = new Date(Date.now() + 19800000); return new Date(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(), t.getUTCHours(), t.getUTCMinutes(), t.getUTCSeconds()); }
function nseIso(d) { return require("../src/utils/nseHolidays").formatDateToYYYYMMDD(d); }

console.log(`\nMARKETS: ${passed} passed, ${failed} failed`);
try { fs.rmSync(TMP_HOME, { recursive: true, force: true }); } catch (_) {}
process.exit(failed ? 1 : 0);

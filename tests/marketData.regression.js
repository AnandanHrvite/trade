#!/usr/bin/env node
/**
 * SHARED MARKET DATA — one broker call, shared, and never a different answer
 *
 *   node tests/marketData.regression.js
 *
 * src/services/marketData.js sits between the paper routes and Fyers so a
 * dashboard Start All (18 strategies) makes ONE call per thing instead of 18.
 * Sharing is only allowed to change HOW OFTEN the broker is asked, never WHAT
 * a caller gets back. This suite pins that down:
 *
 *   · de-duplication — N concurrent callers → 1 upstream call
 *   · TTL            — reuse only inside the window, and only where the answer
 *                      cannot have changed (live history is never reused)
 *   · deep copies    — one caller mutating its candles cannot touch another's
 *   · errors         — same rejection / same {ok:false,…} shape as a direct call,
 *                      and a failure is never cached
 *   · quote batching — ≤50 symbols per upstream call, each caller gets exactly
 *                      its own symbols, irregular replies fall back to a direct call
 *   · pass-through   — MARKET_DATA_SHARED=false and a running replay call the
 *                      broker directly, every time
 *
 * The broker is faked by replacing the functions marketData looks up at call
 * time (fyers.getQuotes / get_profile, backtestEngine.fetchCandles). HOME is a
 * temp dir so nothing touches ~/trading-data.
 */

"use strict";

process.env.TZ = "Asia/Calcutta";
const os = require("os");
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "marketdata-test-"));
process.env.HOME = TMP_HOME;
process.env.USERPROFILE = TMP_HOME;
process.env.TICK_RECORDER_ENABLED = "false";
for (const k of Object.keys(process.env)) if (k.startsWith("TG_") || k.startsWith("TELEGRAM_")) delete process.env[k];
for (const k of ["MARKET_DATA_SHARED", "MARKET_DATA_TTL_SEC", "MARKET_DATA_QUOTE_BATCH_MS"]) delete process.env[k];
process.env.APP_ID = "TEST-100";
process.env.ACCESS_TOKEN = "test-token";

// No real network: a case that forgets a stub must fail here, not reach Fyers/NSE.
for (const m of [require("http"), require("https")]) {
  m.request = () => { throw new Error("marketData test: network blocked"); };
}

const SRC = path.join(__dirname, "..", "src");
const md =require(path.join(SRC, "services", "marketData"));
const fyers = require(path.join(SRC, "config", "fyers"));
const backtestEngine = require(path.join(SRC, "services", "backtestEngine"));
const fyersAuthCheck = require(path.join(SRC, "utils", "fyersAuthCheck"));
const instrument = require(path.join(SRC, "config", "instrument"));

let passed = 0, failed = 0;
const cases = [];
const check = (name, fn) => cases.push({ name, fn });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ORIG = { getQuotes: fyers.getQuotes, get_profile: fyers.get_profile, fetchCandles: backtestEngine.fetchCandles, now: Date.now };
function restore() {
  fyers.getQuotes = ORIG.getQuotes;
  fyers.get_profile = ORIG.get_profile;
  backtestEngine.fetchCandles = ORIG.fetchCandles;
  Date.now = ORIG.now;
  for (const k of ["MARKET_DATA_SHARED", "MARKET_DATA_TTL_SEC", "MARKET_DATA_QUOTE_BATCH_MS"]) delete process.env[k];
  process.env.ACCESS_TOKEN = "test-token";
  md.resetCache();
}

const IST = 19800000;
const istDate = (ms) => new Date(ms + IST).toISOString().slice(0, 10);
// A fixed instant: 2026-11-11 11:00 IST (market hours, a Wednesday).
const T_MKT = Date.parse("2026-11-11T05:30:00Z");
// 2026-11-11 08:30 IST (pre-market).
const T_PRE = Date.parse("2026-11-11T03:00:00Z");

function candles(n, startSec) {
  const out = [];
  for (let i = 0; i < n; i++) out.push({ time: startSec + i * 300, open: 100 + i, high: 101 + i, low: 99 + i, close: 100.5 + i, volume: 0 });
  return out;
}

/** History stub: counts calls, answers after `ms`. */
function stubHistory(ms, make) {
  const calls = [];
  backtestEngine.fetchCandles = async (sym, res, from, to) => {
    calls.push({ sym, res, from, to });
    await sleep(ms);
    return make ? make(sym, res, from, to) : candles(10, 1762800000);
  };
  return calls;
}

/** Quote stub: counts upstream calls, answers every symbol after `ms`. */
function stubQuotes(ms, { reply } = {}) {
  const calls = [];
  fyers.getQuotes = async (symbols) => {
    calls.push(symbols.slice());
    await sleep(ms);
    if (reply) return reply(symbols);
    return { s: "ok", code: 200, message: "", d: symbols.map((s, i) => ({ n: s, s: "ok", v: { lp: 100 + i, symbol: s } })) };
  };
  return calls;
}

// ── De-duplication ──────────────────────────────────────────────────────────

check("18 concurrent warm-up fetches of the same series → 1 upstream call", async () => {
  Date.now = () => T_MKT;
  const calls = stubHistory(40);
  const outs = await Promise.all(Array.from({ length: 18 }, () => md.fetchCandles("NSE:NIFTY50-INDEX", "5", "2026-11-06", "2026-11-11")));
  assert.strictEqual(calls.length, 1, `expected 1 upstream call, got ${calls.length}`);
  for (const o of outs) assert.deepStrictEqual(o, candles(10, 1762800000));
});

check("different series are NOT merged (one call per symbol/resolution/from/to)", async () => {
  Date.now = () => T_MKT;
  const calls = stubHistory(20);
  await Promise.all([
    md.fetchCandles("NSE:NIFTY50-INDEX", "5", "2026-11-06", "2026-11-11"),
    md.fetchCandles("NSE:NIFTY50-INDEX", "15", "2026-11-06", "2026-11-11"),
    md.fetchCandles("NSE:NIFTY50-INDEX", "5", "2026-10-21", "2026-11-11"),
    md.fetchCandles("NSE:SAIL-EQ", "5", "2026-11-06", "2026-11-11"),
  ]);
  assert.strictEqual(calls.length, 4);
});

check("10 concurrent token checks → 1 get_profile call, each gets {ok:true}", async () => {
  let n = 0;
  fyers.get_profile = async () => { n++; await sleep(30); return { s: "ok" }; };
  process.env.ACCESS_TOKEN = `tok-${Math.random()}`;   // defeat fyersAuthCheck's own 10 s cache
  const outs = await Promise.all(Array.from({ length: 10 }, () => md.verifyFyersToken()));
  assert.strictEqual(n, 1, `expected 1 get_profile, got ${n}`);
  for (const o of outs) assert.deepStrictEqual(o, { ok: true });
  outs[0].ok = false;
  assert.strictEqual(outs[1].ok, true, "callers must not share one result object");
});

check("18 concurrent getLiveSpot calls (cold) → 1 quote call", async () => {
  const calls = stubQuotes(30, { reply: (s) => ({ s: "ok", d: [{ n: s[0], v: { lp: 24567.5 } }] }) });
  // instrument keeps its own 60 s spot cache; a fresh underlying key per run is not
  // possible, so step the clock past it.
  Date.now = () => T_MKT + 10 * 60000;
  const outs = await Promise.all(Array.from({ length: 18 }, () => md.getLiveSpot()));
  assert.strictEqual(calls.length, 1, `expected 1 quote call, got ${calls.length}`);
  for (const o of outs) assert.strictEqual(o, 24567.5);
});

check("concurrent option-chain expiry lookups share one call; a null is not cached", async () => {
  let n = 0;
  const d = new Date(2026, 10, 17, 12);
  const a = await Promise.all(Array.from({ length: 6 }, () => md.sharedOptionChainExpiry("NIFTY", async () => { n++; await sleep(20); return d; })));
  assert.strictEqual(n, 1);
  for (const x of a) assert.strictEqual(x.getTime(), d.getTime());
  a[0].setDate(1);
  const again = await md.sharedOptionChainExpiry("NIFTY", async () => { n++; return d; });
  assert.strictEqual(n, 1, "a cached Date within the TTL must be reused");
  assert.strictEqual(again.getTime(), d.getTime(), "a caller mutating its Date must not change the cached one");
  let m = 0;
  await md.sharedOptionChainExpiry("BANKNIFTY", async () => { m++; return null; });
  await md.sharedOptionChainExpiry("BANKNIFTY", async () => { m++; return null; });
  assert.strictEqual(m, 2, "a failed (null) lookup must be retried by the next caller");
});

// ── TTL ─────────────────────────────────────────────────────────────────────

check("closed history (range ends before today) is reused inside the TTL, re-fetched after it", async () => {
  process.env.MARKET_DATA_TTL_SEC = "30";
  let now = T_MKT;
  Date.now = () => now;
  const calls = stubHistory(5);
  await md.fetchCandles("NSE:NIFTY50-INDEX", "D", "2026-10-01", "2026-11-10");
  now += 20000;
  await md.fetchCandles("NSE:NIFTY50-INDEX", "D", "2026-10-01", "2026-11-10");
  assert.strictEqual(calls.length, 1, "inside the TTL the closed series must be reused");
  now += 15000;   // 35 s after the fetch
  await md.fetchCandles("NSE:NIFTY50-INDEX", "D", "2026-10-01", "2026-11-10");
  assert.strictEqual(calls.length, 2, "past the TTL the series must be fetched again");
});

check("a series reaching into today's LIVE session is never served from the TTL", async () => {
  process.env.MARKET_DATA_TTL_SEC = "300";
  let now = T_MKT;
  Date.now = () => now;
  const calls = stubHistory(5);
  await md.fetchCandles("NSE:NIFTY50-INDEX", "5", "2026-11-06", istDate(now));
  now += 1000;
  await md.fetchCandles("NSE:NIFTY50-INDEX", "5", "2026-11-06", istDate(now));
  assert.strictEqual(calls.length, 2, "a forming bar may have moved — every sequential call must go to the broker");
});

check("pre-market: today's range is reused only while no bar for today can exist", async () => {
  process.env.MARKET_DATA_TTL_SEC = "300";
  let now = T_PRE;   // 08:30 IST
  Date.now = () => now;
  const todayStartSec = Math.floor((Date.parse("2026-11-11T00:00:00Z") - IST) / 1000);
  const calls = stubHistory(5, () => candles(5, todayStartSec - 86400));   // yesterday's bars only
  await md.fetchCandles("NSE:NIFTY50-INDEX", "5", "2026-11-06", "2026-11-11");
  now += 60000;   // 08:31
  await md.fetchCandles("NSE:NIFTY50-INDEX", "5", "2026-11-06", "2026-11-11");
  assert.strictEqual(calls.length, 1, "08:30 → 08:31 nothing for today exists; reuse is exact");
  now = Date.parse("2026-11-11T03:31:00Z");   // 09:01 IST — pre-open has begun
  await md.fetchCandles("NSE:NIFTY50-INDEX", "5", "2026-11-06", "2026-11-11");
  assert.strictEqual(calls.length, 2, "from 09:00 IST the response must be fetched fresh");

  // A response that already holds a bar dated today is never reused, whatever the hour.
  md.resetCache();
  now = T_PRE;
  const c2 = stubHistory(5, () => candles(3, todayStartSec + 60));
  await md.fetchCandles("NSE:NIFTY50-INDEX", "5", "2026-11-06", "2026-11-11");
  await md.fetchCandles("NSE:NIFTY50-INDEX", "5", "2026-11-06", "2026-11-11");
  assert.strictEqual(c2.length, 2);
});

check("MARKET_DATA_TTL_SEC=0 → only in-flight sharing, no reuse afterwards", async () => {
  process.env.MARKET_DATA_TTL_SEC = "0";
  Date.now = () => T_MKT;
  const calls = stubHistory(5);
  await Promise.all([1, 2, 3].map(() => md.fetchCandles("NSE:NIFTY50-INDEX", "D", "2026-10-01", "2026-11-10")));
  assert.strictEqual(calls.length, 1);
  await md.fetchCandles("NSE:NIFTY50-INDEX", "D", "2026-10-01", "2026-11-10");
  assert.strictEqual(calls.length, 2);
});

check("isTradingAllowed is shared per IST minute — the next minute asks again", async () => {
  const nse = require(path.join(SRC, "utils", "nseHolidays"));
  const orig = nse.isTradingAllowed;
  let n = 0;
  let now = T_MKT;
  Date.now = () => now;
  nse.isTradingAllowed = async () => { n++; await sleep(5); return { allowed: true, reason: "Trading allowed" }; };
  try {
    await Promise.all([1, 2, 3, 4].map(() => md.isTradingAllowed()));
    await md.isTradingAllowed();
    assert.strictEqual(n, 1, "same minute → one evaluation");
    now += 60000;
    await md.isTradingAllowed();
    assert.strictEqual(n, 2, "a new IST minute must be evaluated afresh");
  } finally { nse.isTradingAllowed = orig; }
});

check("an empty history (expired token returns 0 candles) is never cached", async () => {
  Date.now = () => T_MKT;
  const calls = stubHistory(5, () => []);
  await md.fetchCandles("NSE:NIFTY50-INDEX", "D", "2026-10-01", "2026-11-10");
  await md.fetchCandles("NSE:NIFTY50-INDEX", "D", "2026-10-01", "2026-11-10");
  assert.strictEqual(calls.length, 2);
});

// ── Deep copies ─────────────────────────────────────────────────────────────

check("callers get isolated deep copies — mutating one series touches no other", async () => {
  process.env.MARKET_DATA_TTL_SEC = "30";
  Date.now = () => T_MKT;
  stubHistory(10);
  const [a, b] = await Promise.all([
    md.fetchCandles("NSE:NIFTY50-INDEX", "D", "2026-10-01", "2026-11-10"),
    md.fetchCandles("NSE:NIFTY50-INDEX", "D", "2026-10-01", "2026-11-10"),
  ]);
  assert.notStrictEqual(a, b);
  a[0].close = -1; a.pop(); a.push({ time: 1 });
  assert.deepStrictEqual(b, candles(10, 1762800000), "the other concurrent caller was affected");
  const c = await md.fetchCandles("NSE:NIFTY50-INDEX", "D", "2026-10-01", "2026-11-10");
  assert.deepStrictEqual(c, candles(10, 1762800000), "the cached copy was affected");
});

check("quote rows are copies too", async () => {
  stubQuotes(10);
  const [r1, r2] = await Promise.all([md.getQuotes(["NSE:A"]), md.getQuotes(["NSE:A"])]);
  r1.d[0].v.lp = -1;
  assert.strictEqual(r2.d[0].v.lp, 100);
});

// ── Errors ──────────────────────────────────────────────────────────────────

check("a thrown history error reaches every concurrent caller unchanged and is not cached", async () => {
  Date.now = () => T_MKT;
  let n = 0;
  const boom = new Error("Fyers history failed: code -16");
  backtestEngine.fetchCandles = async () => { n++; await sleep(10); throw boom; };
  const settled = await Promise.allSettled([1, 2, 3].map(() => md.fetchCandles("NSE:NIFTY50-INDEX", "D", "2026-10-01", "2026-11-10")));
  assert.strictEqual(n, 1);
  for (const s of settled) {
    assert.strictEqual(s.status, "rejected");
    assert.strictEqual(s.reason, boom, "the caller must see the broker's own error");
  }
  await md.fetchCandles("NSE:NIFTY50-INDEX", "D", "2026-10-01", "2026-11-10").catch(() => {});
  assert.strictEqual(n, 2, "a failure must not be cached");
});

check("a rejected token gives the same {ok:false,code,message} as the direct check", async () => {
  const resp = { s: "error", code: -16, message: "Could not authenticate the user" };
  fyers.get_profile = async () => resp;
  // fyersAuthCheck caches an OK for 10 s (any token) — step past an earlier case's OK.
  const base = ORIG.now() + 60000;
  Date.now = () => base;
  const origClear = fyers.clearFyersToken;
  fyers.clearFyersToken = () => {};
  try {
    process.env.ACCESS_TOKEN = "bad-1";
    const direct = await fyersAuthCheck.verifyFyersToken();
    process.env.ACCESS_TOKEN = "bad-2";
    const shared = await Promise.all([md.verifyFyersToken(), md.verifyFyersToken()]);
    for (const s of shared) assert.deepStrictEqual(s, direct);
    assert.strictEqual(direct.ok, false);
    assert.strictEqual(direct.code, "INVALID_TOKEN");
    delete process.env.ACCESS_TOKEN;
    const none = await md.verifyFyersToken();
    assert.strictEqual(none.code, "NO_TOKEN");
  } finally { fyers.clearFyersToken = origClear; }
});

check("a quote call that throws propagates the same error for a single-symbol request", async () => {
  const boom = new Error("ECONNRESET");
  fyers.getQuotes = async () => { await sleep(5); throw boom; };
  await assert.rejects(md.getQuotes(["NSE:X"]), (e) => e === boom);
});

check("a single-symbol error reply is returned exactly as the broker sent it", async () => {
  const reply = { s: "error", code: -300, message: "request limit reached" };
  fyers.getQuotes = async () => { await sleep(5); return reply; };
  const r = await md.getQuotes(["NSE:X"]);
  assert.deepStrictEqual(r, reply);
});

// ── Quote batching ──────────────────────────────────────────────────────────

check("120 concurrent single-symbol requests → 3 upstream calls of ≤50, each gets its own row", async () => {
  const calls = stubQuotes(20);
  const syms = Array.from({ length: 120 }, (_, i) => `NSE:NIFTY26N17${24000 + i * 50}CE`);
  const outs = await Promise.all(syms.map((s) => md.getQuotes([s])));
  assert.strictEqual(calls.length, 3, `expected 3 upstream calls, got ${calls.length}`);
  assert.ok(calls.every((c) => c.length <= md.QUOTE_MAX_SYMBOLS), "a call exceeded the 50-symbol limit");
  assert.deepStrictEqual(calls.flat().sort(), syms.slice().sort(), "every symbol asked exactly once");
  outs.forEach((r, i) => {
    assert.strictEqual(r.s, "ok");
    assert.strictEqual(r.d.length, 1);
    assert.strictEqual(r.d[0].n, syms[i], "caller got another symbol's row");
  });
});

check("the same symbol from many callers is asked once; multi-symbol requests keep their order", async () => {
  const calls = stubQuotes(20);
  const [a, b, c] = await Promise.all([
    md.getQuotes(["NSE:A"]),
    md.getQuotes(["NSE:C", "NSE:A", "NSE:B"]),
    md.getQuotes(["NSE:A"]),
  ]);
  assert.strictEqual(calls.length, 1);
  assert.deepStrictEqual(calls[0], ["NSE:A", "NSE:C", "NSE:B"]);
  assert.strictEqual(a.d[0].n, "NSE:A");
  assert.deepStrictEqual(b.d.map((r) => r.n), ["NSE:C", "NSE:A", "NSE:B"]);
  assert.strictEqual(c.d[0].n, "NSE:A");
  assert.strictEqual(b.s, "ok");
  assert.strictEqual(b.code, 200, "top-level fields are kept");
});

check("a merged batch the broker rejects falls back to each caller's own direct call", async () => {
  const calls = [];
  fyers.getQuotes = async (symbols) => {
    calls.push(symbols.slice());
    await sleep(5);
    if (symbols.length > 1) return { s: "error", code: -50, message: "invalid symbol in request" };
    return symbols[0] === "NSE:BAD"
      ? { s: "error", code: -50, message: "invalid symbol" }
      : { s: "ok", d: [{ n: symbols[0], v: { lp: 7 } }] };
  };
  const [good, bad] = await Promise.all([md.getQuotes(["NSE:GOOD"]), md.getQuotes(["NSE:BAD"])]);
  assert.deepStrictEqual(good, { s: "ok", d: [{ n: "NSE:GOOD", v: { lp: 7 } }] });
  assert.deepStrictEqual(bad, { s: "error", code: -50, message: "invalid symbol" });
  assert.strictEqual(calls.length, 3, "1 merged attempt + 1 direct call per caller");
});

check("a symbol missing from a merged reply falls back to a direct call for that caller", async () => {
  const calls = [];
  fyers.getQuotes = async (symbols) => {
    calls.push(symbols.slice());
    await sleep(5);
    return { s: "ok", d: symbols.filter((s) => s !== "NSE:GONE").map((s) => ({ n: s, v: { lp: 1 } })) };
  };
  const [x, gone] = await Promise.all([md.getQuotes(["NSE:X"]), md.getQuotes(["NSE:GONE"])]);
  assert.strictEqual(x.d[0].n, "NSE:X");
  assert.deepStrictEqual(gone, { s: "ok", d: [] }, "the caller must get what a direct call returns");
  assert.strictEqual(calls.length, 2);
});

check("contract checks may reuse a recent clean row; price requests never do", async () => {
  process.env.MARKET_DATA_TTL_SEC = "30";
  const calls = stubQuotes(5);
  await md.getQuotes(["NSE:K"]);
  await md.getQuotes(["NSE:K"], { maxAgeMs: md.ttlMs() });
  assert.strictEqual(calls.length, 1, "a contract check within the window reuses the row");
  await md.getQuotes(["NSE:K"]);
  assert.strictEqual(calls.length, 2, "a price request must always go to the broker");
});

check("validateAndGetOptionSymbol: 18 strategies resolving at once → 1 chain call per index + 1 check per symbol", async () => {
  delete process.env.OPTION_EXPIRY_OVERRIDE;
  delete process.env.NIFTY_EXPIRY_OVERRIDE;
  Date.now = () => T_MKT;
  const https = require("https");
  const origGet = https.get;
  let chainCalls = 0;
  const { EventEmitter } = require("events");
  https.get = (url, opts, cb) => {
    chainCalls++;
    const req = new EventEmitter();
    req.setTimeout = () => req; req.destroy = () => {};
    setTimeout(() => {
      const res = new EventEmitter();
      cb(res);
      res.emit("data", JSON.stringify({ s: "ok", data: { expiryData: [{ date: "17-11-2026" }] } }));
      res.emit("end");
    }, 30);
    return req;
  };
  const calls = stubQuotes(30);
  try {
    const modes = ["ema_rsi_st", "ema9vwap", "ema_rsi_st_v2", "x1", "x2", "x3", "x4", "x5", "x6"];
    const outs = await Promise.all(modes.flatMap((m) => [
      instrument.validateAndGetOptionSymbol(24610, "CE", m),
      instrument.validateAndGetOptionSymbol(24610, "PE", m),
    ]));
    assert.strictEqual(chainCalls, 1, `expected 1 option-chain call, got ${chainCalls}`);
    const asked = calls.flat();
    assert.strictEqual(new Set(asked).size, asked.length, "a contract was checked twice");
    assert.strictEqual(asked.length, 2, `expected 2 contract checks (one CE, one PE), got ${asked.length}`);
    for (const o of outs) assert.ok(o.symbol && !o.invalid, "resolution must still succeed");
  } finally { https.get = origGet; }
});

// ── Pass-through ────────────────────────────────────────────────────────────

check("MARKET_DATA_SHARED=false → every call goes straight to the broker", async () => {
  process.env.MARKET_DATA_SHARED = "false";
  Date.now = () => T_MKT;
  const h = stubHistory(10);
  await Promise.all([1, 2, 3].map(() => md.fetchCandles("NSE:NIFTY50-INDEX", "D", "2026-10-01", "2026-11-10")));
  assert.strictEqual(h.length, 3);
  const q = stubQuotes(5);
  await Promise.all([md.getQuotes(["NSE:A"]), md.getQuotes(["NSE:A"])]);
  assert.strictEqual(q.length, 2);
});

check("while a replay is running, every call is a direct pass-through (and returns the broker's own promise)", async () => {
  const replayPath = require.resolve(path.join(SRC, "services", "tickReplay"));
  const had = require.cache[replayPath];
  require.cache[replayPath] = { id: replayPath, filename: replayPath, loaded: true, exports: { isReplayInProgress: () => true } };
  try {
    Date.now = () => T_MKT;
    const h = stubHistory(10);
    await Promise.all([1, 2, 3].map(() => md.fetchCandles("NSE:NIFTY50-INDEX", "D", "2026-10-01", "2026-11-10")));
    assert.strictEqual(h.length, 3);
    const p = Promise.resolve({ s: "ok", d: [] });
    fyers.getQuotes = () => p;
    assert.strictEqual(md.getQuotes(["NSE:A"]), p, "replay must await the stub's own promise");
    assert.strictEqual(md.stats().cached, 0, "nothing may be cached during a replay");
  } finally {
    if (had) require.cache[replayPath] = had; else delete require.cache[replayPath];
  }
});

check("malformed quote input (duplicates / non-array) is passed through untouched", async () => {
  const calls = stubQuotes(1);
  await md.getQuotes(["NSE:A", "NSE:A"]);
  assert.deepStrictEqual(calls[0], ["NSE:A", "NSE:A"]);
});

// ── Wiring ──────────────────────────────────────────────────────────────────

check("the paper routes take their shared calls from marketData, not the broker", () => {
  const ROUTES = ["emaRsiStPaper", "bbRsiPaper", "paPaper", "orbPaper", "ema9vwapPaper", "trendPbPaper", "trendDayScalpPaper",
    "haScalpPaper", "prevOrbScalpPaper", "itm20ScalpPaper", "rsiPivotStPaper", "simple930Paper", "earlyBirdPaper",
    "emaRsiStV2Paper", "stRsiPivBbPaper", "pivotEmaStPaper", "gapRunawayPaper", "sailVwapStPaper", "gapRunawayStkPaper"];
  for (const r of ROUTES) {
    const src = fs.readFileSync(path.join(SRC, "routes", `${r}.js`), "utf8");
    assert.ok(/const \{ verifyFyersToken \} = require\("\.\.\/services\/marketData"\)/.test(src), `${r}: token check not shared`);
    assert.ok(/const \{ isTradingAllowed[^}]*\} = require\("\.\.\/services\/marketData"\)/.test(src), `${r}: trading-day check not shared`);
    assert.ok(!/fyers\.getQuotes\(/.test(src), `${r}: calls fyers.getQuotes directly`);
    assert.ok(!/require\("\.\.\/utils\/fyersAuthCheck"\)/.test(src), `${r}: still imports fyersAuthCheck`);
  }
});

check("Start All runs a bounded pool, not one start after another", () => {
  const app = fs.readFileSync(path.join(SRC, "app.js"), "utf8");
  const i = app.indexOf("async function _startAll(endpoints)");
  assert.ok(i > 0, "_startAll not found");
  const body = app.slice(i, app.indexOf("\n}\n", i));
  assert.ok(/START_ALL_CONCURRENCY/.test(body) && /Promise\.all\(pool\)/.test(body), "Start All is not a concurrency pool");
  assert.ok(/_startAllClickBusy/.test(app), "the double-click guard is gone");
});

(async () => {
  for (const c of cases) {
    restore();
    try {
      await c.fn();
      passed++;
      console.log(`  ✅ ${c.name}`);
    } catch (e) {
      failed++;
      console.log(`  ❌ ${c.name}\n       ${(e && e.message || String(e)).split("\n").join("\n       ")}`);
    }
  }
  restore();
  try { fs.rmSync(TMP_HOME, { recursive: true, force: true }); } catch (_) {}
  console.log(failed ? `\nFAILURES — ${passed} passed, ${failed} failed` : `\nALL PASS — ${passed} passed, 0 failed`);
  process.exit(failed ? 1 : 0);
})();

#!/usr/bin/env node
/**
 * SHARED SPOT FEED — RECONNECTS MUST KEEP SENDING
 *
 *   node tests/socketFeed.regression.js
 *
 * The REAL fyers-api-v3 SDK and the REAL socketManager; only the network is
 * faked (the `ws` module the SDK's HSWebSocket uses, and the symbol-token REST
 * call). HOME points at a temp dir and the SDK log path is a temp dir too.
 *
 * 2026-10-08: the SDK clears its send-queue drainer and its 1-second
 * send-budget reset timer on EVERY close, and only the constructor creates the
 * reset timer. After the first idle drop (07:41) the process could send ~11
 * more frames in total, then every reconnect "Connected — subscribing" with the
 * login frame stuck in the queue: zero ticks all day, re-login included.
 * guardSdkTimers() owns both timers; this test fails if a reconnect, a
 * watchdog reconnect, a re-login or a stop/start ever sends nothing again.
 */

process.env.TZ = "Asia/Calcutta";
const os = require("os");
const fs = require("fs");
const path = require("path");
const Module = require("module");
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "socketfeed-test-"));
process.env.HOME = TMP_HOME;
process.env.USERPROFILE = TMP_HOME;
process.env.TICK_RECORDER_ENABLED = "false";
for (const k of Object.keys(process.env)) if (k.startsWith("TG_") || k.startsWith("TELEGRAM_")) delete process.env[k];
const ROOT = path.join(__dirname, "..");
process.chdir(TMP_HOME);   // the SDK writes its logs under ./logs

// ── Live-interval accounting (leak check) ──────────────────────────────────
const live = new Set();
const _si = global.setInterval, _ci = global.clearInterval;
global.setInterval = function (...a) { const t = _si(...a); live.add(t); return t; };
global.clearInterval = function (t) { live.delete(t); return _ci(t); };

// ── Fake network ────────────────────────────────────────────────────────────
const socks = [];
class FakeWS {
  constructor(url) {
    this.url = url; this.readyState = 0; this.sends = 0; this.id = socks.length; socks.push(this);
    setTimeout(() => { if (this.readyState !== 0) return; this.readyState = 1; if (this.onopen) this.onopen({}); }, 30);
  }
  send() { this.sends++; }
  close() {
    if (this.readyState >= 2) return;
    this.readyState = 3;
    // Late, like the real one — this is the echo that used to land on the NEXT connection.
    setTimeout(() => { if (this.onclose) this.onclose({ code: 1000, reason: "", wasClean: true }); }, 40);
  }
  serverDrop() { this.readyState = 3; if (this.onclose) this.onclose({ code: 1006, reason: "idle", wasClean: false }); }
}
FakeWS.OPEN = 1; FakeWS.CONNECTING = 0; FakeWS.CLOSED = 3;
const _load = Module._load;
Module._load = function (req, parent, ...rest) {
  if (req === "ws" && parent && /fyers-api-v3/.test(parent.filename)) return FakeWS;
  return _load.call(this, req, parent, ...rest);
};

const b64 = (x) => Buffer.from(JSON.stringify(x)).toString("base64url");
const jwt = (k) => `${b64({ alg: "HS256" })}.${b64({ hsm_key: k, exp: 9999999999 })}.sig`;
process.env.APP_ID = "TEST-100";
process.env.ACCESS_TOKEN = jwt("k1");

const api = require(path.join(ROOT, "node_modules/fyers-api-v3/apiService/apiService.js"));
api.axiosInstance.post = async () => ({ data: { validSymbol: {
  "NSE:NIFTY50-INDEX": "101000000026000", "NSE:NIFTYBANK-INDEX": "101000000026009" } } });

// The SDK is chatty on stdout; keep the test output readable.
const _log = console.log;
console.log = (...a) => { if (process.env.VERBOSE) _log(...a); };

const sm = require(path.join(ROOT, "src/utils/socketManager.js"));
sm._isMarketHours = () => true;   // reconnects are gated on market hours / an active strategy

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const cur = () => socks[socks.length - 1];
let lastChecked = -1, passed = 0, failed = 0;

async function expectSending(name, maxMs = 9000) {
  const t0 = Date.now();
  let s;
  while (Date.now() - t0 < maxMs) {
    s = cur();
    if (s && s.id > lastChecked && s.readyState === 1 && s.sends >= 2) break;
    await wait(100);
  }
  s = cur(); lastChecked = s ? s.id : lastChecked;
  if (s && s.readyState === 1 && s.sends >= 2) { passed++; _log(`  ✓ ${name} (ws#${s.id}, ${s.sends} frames)`); }
  else { failed++; _log(`  ✗ ${name} — connection open=${!!s && s.readyState === 1}, frames sent=${s ? s.sends : 0} (login/subscribe never left the SDK queue)`); }
}
function expect(name, cond, detail) {
  if (cond) { passed++; _log(`  ✓ ${name}`); } else { failed++; _log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

(async () => {
  _log("socketFeed regression");
  sm.start("NSE:NIFTY50-INDEX", () => {}, () => {});
  sm._clearWatchdog();   // the test drives reconnects itself
  await expectSending("first connect sends login + subscribe");

  cur().serverDrop();
  await expectSending("reconnect after server idle-drop #1", 15000);
  cur().serverDrop();
  await expectSending("reconnect after server idle-drop #2", 15000);

  for (let i = 1; i <= 3; i++) { sm._connect(); await expectSending(`watchdog reconnect #${i}`); }

  sm.addSpotSymbol("NSE:NIFTYBANK-INDEX", () => {}, () => {});
  await wait(300);
  sm._connect();
  await expectSending("watchdog reconnect with two indices");

  process.env.ACCESS_TOKEN = jwt("k2");
  sm.reauth();
  await expectSending("re-login (reauth) with a new token");
  sm._connect();
  await expectSending("watchdog reconnect after re-login");

  const before = live.size;
  for (let i = 0; i < 25; i++) { sm._connect(); await wait(120); }
  await expectSending("after 25 rapid reconnects");
  expect("no interval leak across reconnects", live.size - before <= 1, `${before} → ${live.size} live intervals`);

  sm.stop();
  await wait(200);
  expect("stop() releases the SDK timers", live.size === 0, `${live.size} interval(s) still live`);

  sm.start("NSE:NIFTY50-INDEX", () => {}, () => {});
  sm._clearWatchdog();
  await expectSending("stop + fresh start");
  sm.stop();

  // ── freshSpot: a frozen tick must never be decided on when a quote exists ──
  _log("freshSpot");
  const fyers = require(path.join(ROOT, "src/config/fyers"));
  const { freshSpot } = require(path.join(ROOT, "src/utils/freshSpot"));
  const origQ = fyers.getQuotes;
  let quoteCalls = 0;
  fyers.getQuotes = async (syms) => { quoteCalls++; return { s: "ok", d: [{ n: syms[0], v: { lp: 22470.5 } }] }; };
  let r = await freshSpot({ tickPrice: 22500, tickAt: Date.now() - 2000 });
  expect("fresh tick is used as-is, no quote call", r.spot === 22500 && r.source === "tick" && quoteCalls === 0, JSON.stringify(r));
  r = await freshSpot({ tickPrice: 22603.05, tickAt: Date.now() - 2 * 3600_000 });
  expect("stale tick (2h, the 2026-10-08 case) → quoted spot", r.spot === 22470.5 && r.source === "quote", JSON.stringify(r));
  r = await freshSpot({ tickPrice: null, tickAt: null });
  expect("no tick at all → quoted spot", r.spot === 22470.5 && r.source === "quote", JSON.stringify(r));
  let asked = null;
  fyers.getQuotes = async (syms) => { asked = syms[0]; return { s: "ok", d: [{ v: { lp: 54800 } }] }; };
  r = await freshSpot({ tickPrice: null, tickAt: null, underlying: "BANKNIFTY" });
  expect("BANKNIFTY quotes the BANKNIFTY index", asked === "NSE:NIFTYBANK-INDEX" && r.spot === 54800, `asked ${asked}`);
  fyers.getQuotes = async () => { throw new Error("network down"); };
  r = await freshSpot({ tickPrice: 22603.05, tickAt: Date.now() - 600_000 });
  expect("quote failure falls back to the old tick (never blocks)", r.spot === 22603.05 && r.source === "stale-tick", JSON.stringify(r));
  fyers.getQuotes = async () => ({ s: "error", code: -16 });
  r = await freshSpot({ tickPrice: null, tickAt: null });
  expect("quote error and no tick → null (caller defers)", r.spot === null && r.source === "none", JSON.stringify(r));
  fyers.getQuotes = origQ;

  _log(`\n${passed} passed, ${failed} failed`);
  setTimeout(() => process.exit(failed ? 1 : 0), 100);
})().catch((e) => { _log("socketFeed regression crashed:", e); process.exit(2); });

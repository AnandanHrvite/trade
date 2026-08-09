/**
 * optionFeedTest.js — guards the socket-multiplexed option feed
 *
 *   node scripts/optionFeedTest.js
 *
 * The dangerous failure this suite exists to prevent is an option premium
 * reaching a strategy's spot tick handler, where it would be written into the
 * NIFTY candle series. Everything else here (leases, freshness, fallback) can
 * only cost us the optimisation; that one can corrupt a trading session.
 */

process.env.TICK_RECORDER_ENABLED = "false";

const assert = require("assert");
const socketManager = require("../src/utils/socketManager");
const optionFeed    = require("../src/utils/optionFeed");

const SPOT   = "NSE:NIFTY50-INDEX";
const OPT    = "NSE:NIFTY2580724500CE";
const OPT2   = "NSE:NIFTY2580724600PE";

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); passed++; }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); failed++; }
}

/** Put the manager in a "connected, nothing learned yet" state without a socket. */
function resetManager() {
  optionFeed._reset();
  socketManager._callbacks.clear();
  socketManager._extraSymbols.clear();
  socketManager._onSpotTick = null;
  socketManager._onExtraTick = null;
  socketManager._spotTickSymbol = null;
  socketManager._attributionLogged = false;
  socketManager._unattributedCount = 0;
  socketManager._stopped = false;
  socketManager._onLog = () => {};
  // Stand in for the SDK so subscribe/unsubscribe are observable and offline.
  const wire = { subscribed: [], unsubscribed: [] };
  socketManager._skt = {
    subscribe:   (syms) => wire.subscribed.push(...syms),
    unsubscribe: (syms) => wire.unsubscribed.push(...syms),
  };
  return wire;
}

const spotTick = (ltp) => ({ symbol: SPOT, ltp });
const optTick  = (sym, ltp) => ({ symbol: sym, ltp });

console.log("\n── tickSymbol resolution ──");

test("reads the documented field", () => {
  assert.strictEqual(socketManager.tickSymbol({ symbol: SPOT }), SPOT);
});

test("falls back to alternative field names", () => {
  assert.strictEqual(socketManager.tickSymbol({ sym: SPOT }), SPOT);
  assert.strictEqual(socketManager.tickSymbol({ n: SPOT }), SPOT);
});

test("returns null when no identifier is present", () => {
  assert.strictEqual(socketManager.tickSymbol({ ltp: 100 }), null);
  assert.strictEqual(socketManager.tickSymbol({ symbol: "   " }), null);
  assert.strictEqual(socketManager.tickSymbol(null), null);
});

console.log("\n── attribution probe gates option subscriptions ──");

test("extras are refused before any tick has been seen", () => {
  resetManager();
  assert.strictEqual(socketManager.canSubscribeExtras(), false);
  assert.strictEqual(socketManager.subscribeExtra(OPT), false);
  assert.strictEqual(socketManager.getExtraSymbols().length, 0);
});

test("extras stay refused forever when ticks carry no symbol", () => {
  resetManager();
  for (let i = 0; i < 50; i++) socketManager._routeTick({ ltp: 24000 + i });
  assert.strictEqual(socketManager.canSubscribeExtras(), false,
    "unidentifiable ticks must never unlock option subscriptions");
});

test("a symbol-bearing spot tick unlocks extras", () => {
  const wire = resetManager();
  socketManager._routeTick(spotTick(24000));
  assert.strictEqual(socketManager.canSubscribeExtras(), true);
  assert.strictEqual(socketManager.subscribeExtra(OPT), true);
  assert.deepStrictEqual(wire.subscribed, [OPT]);
});

test("a failed wire subscribe leaves no phantom subscription", () => {
  resetManager();
  socketManager._routeTick(spotTick(24000));
  socketManager._skt.subscribe = () => { throw new Error("wire down"); };
  assert.strictEqual(socketManager.subscribeExtra(OPT), false);
  assert.strictEqual(socketManager.getExtraSymbols().includes(OPT), false,
    "a symbol that failed to subscribe must not be re-asserted on reconnect");
});

console.log("\n── tick routing (the corruption guard) ──");

test("option ticks never reach the strategy fan-out", () => {
  resetManager();
  const spotSeen = [], optSeen = [];
  socketManager.addCallback("strategy", (t) => spotSeen.push(t.ltp), () => {});
  socketManager.setExtraTickHandler((sym, t) => optSeen.push([sym, t.ltp]));
  socketManager._routeTick(spotTick(24000));       // probe + deliver
  socketManager.subscribeExtra(OPT);
  socketManager._routeTick(optTick(OPT, 182));     // must NOT reach the strategy
  socketManager._routeTick(spotTick(24010));

  assert.deepStrictEqual(spotSeen, [24000, 24010], "strategy saw a non-spot price");
  assert.deepStrictEqual(optSeen, [[OPT, 182]]);
});

test("unattributable ticks are dropped while options are subscribed", () => {
  resetManager();
  const spotSeen = [];
  socketManager.addCallback("strategy", (t) => spotSeen.push(t.ltp), () => {});
  socketManager._routeTick(spotTick(24000));
  socketManager.subscribeExtra(OPT);
  socketManager._routeTick({ ltp: 999 });                    // no symbol at all
  socketManager._routeTick({ symbol: "NSE:SOMETHING", ltp: 5 });  // never subscribed

  assert.deepStrictEqual(spotSeen, [24000], "an unidentified tick leaked into the strategy");
  assert.strictEqual(socketManager._unattributedCount, 2);
});

test("spot ticks are unaffected when no options are subscribed", () => {
  resetManager();
  const spotSeen = [];
  socketManager.addCallback("strategy", (t) => spotSeen.push(t.ltp), () => {});
  socketManager._routeTick({ ltp: 24000 });   // no symbol — legacy shape
  socketManager._routeTick({ ltp: 24010 });
  assert.deepStrictEqual(spotSeen, [24000, 24010],
    "pre-existing behaviour must be untouched when the feature is dormant");
});

test("reconnect re-asserts every option subscription", () => {
  const wire = resetManager();
  socketManager._routeTick(spotTick(24000));
  socketManager.subscribeExtra(OPT);
  socketManager.subscribeExtra(OPT2);
  wire.subscribed.length = 0;
  // What the 'connect' handler does after a drop:
  socketManager._sendSubscribe(socketManager.getExtraSymbols());
  assert.deepStrictEqual(wire.subscribed.sort(), [OPT, OPT2].sort());
});

console.log("\n── optionFeed leases ──");

test("track subscribes and streams pushes to the owner", () => {
  resetManager();
  socketManager._routeTick(spotTick(24000));
  const seen = [];
  assert.strictEqual(optionFeed.track("gaps-paper", OPT, (ltp, at) => seen.push([ltp, at])), true);
  socketManager._routeTick(optTick(OPT, 182));
  assert.strictEqual(seen.length, 1);
  assert.strictEqual(seen[0][0], 182);
  assert.ok(seen[0][1] > 0, "observation timestamp must be supplied to the owner");
});

test("getFresh serves a recent price and refuses a stale one", () => {
  resetManager();
  socketManager._routeTick(spotTick(24000));
  optionFeed.track("gaps-paper", OPT, () => {});
  socketManager._routeTick(optTick(OPT, 182));

  const fresh = optionFeed.getFresh(OPT, 5000);
  assert.strictEqual(fresh.ltp, 182);
  assert.ok(Date.now() - fresh.at < 1000);

  // Let the price genuinely age, then ask with a tolerance it now exceeds.
  const until = Date.now() + 12;
  while (Date.now() < until) { /* deliberate busy-wait: no timers in this suite */ }
  assert.strictEqual(optionFeed.getFresh(OPT, 5), null,
    "a price older than the caller's tolerance must force the REST fallback");
  assert.strictEqual(optionFeed.getFresh("NSE:NEVER-SUBSCRIBED", 5000), null);
});

test("two owners on the same contract both get pushed", () => {
  resetManager();
  socketManager._routeTick(spotTick(24000));
  let a = 0, b = 0;
  optionFeed.track("bb_rsi-paper", OPT, () => a++);
  optionFeed.track("pa-paper", OPT, () => b++);
  socketManager._routeTick(optTick(OPT, 190));
  assert.strictEqual(a, 1);
  assert.strictEqual(b, 1);
  assert.strictEqual(socketManager.getExtraSymbols().length, 1, "one wire subscription, not two");
});

test("release drops the subscription only when the last owner leaves", () => {
  resetManager();
  socketManager._routeTick(spotTick(24000));
  optionFeed.track("bb_rsi-paper", OPT, () => {});
  optionFeed.track("pa-paper", OPT, () => {});

  optionFeed.release("bb_rsi-paper");
  assert.deepStrictEqual(socketManager.getExtraSymbols(), [OPT],
    "the other strategy still holds this contract");

  optionFeed.release("pa-paper");
  assert.deepStrictEqual(socketManager.getExtraSymbols(), [],
    "nobody holds it any more — it must be unsubscribed");
});

test("switching strike releases the old contract", () => {
  resetManager();
  socketManager._routeTick(spotTick(24000));
  optionFeed.track("orb-paper", OPT, () => {});
  optionFeed.track("orb-paper", OPT2, () => {});
  optionFeed.release("orb-paper");
  assert.deepStrictEqual(socketManager.getExtraSymbols(), []);
});

test("the kill-switch makes every call a no-op", () => {
  resetManager();
  socketManager._routeTick(spotTick(24000));
  process.env.OPTION_SOCKET_FEED_ENABLED = "false";
  try {
    assert.strictEqual(optionFeed.track("gaps-paper", OPT, () => {}), false);
    assert.strictEqual(optionFeed.getFresh(OPT, 5000), null);
    assert.deepStrictEqual(socketManager.getExtraSymbols(), []);
  } finally {
    delete process.env.OPTION_SOCKET_FEED_ENABLED;
  }
});

test("a throwing owner callback cannot break the feed", () => {
  resetManager();
  socketManager._routeTick(spotTick(24000));
  let good = 0;
  optionFeed.track("bad-owner", OPT, () => { throw new Error("boom"); });
  optionFeed.track("good-owner", OPT, () => { good++; });
  socketManager._routeTick(optTick(OPT, 200));
  assert.strictEqual(good, 1, "one bad listener must not starve the others");
  assert.strictEqual(optionFeed.getFresh(OPT, 5000).ltp, 200);
});

test("zero and negative premiums are ignored", () => {
  resetManager();
  socketManager._routeTick(spotTick(24000));
  optionFeed.track("gaps-paper", OPT, () => {});
  socketManager._routeTick(optTick(OPT, 150));
  socketManager._routeTick({ symbol: OPT, ltp: 0 });
  socketManager._routeTick({ symbol: OPT, ltp: -5 });
  assert.strictEqual(optionFeed.getFresh(OPT, 5000).ltp, 150,
    "a junk price must not overwrite the last good one");
});

console.log(`\n${failed ? "❌" : "✅"} ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);

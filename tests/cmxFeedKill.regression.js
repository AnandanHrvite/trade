#!/usr/bin/env node
/**
 * COMMODITY NO-PRICE KILL — RULE INVARIANTS
 *
 *   node tests/cmxFeedKill.regression.js
 *
 * An open commodity trade whose future or option has had no new price for
 * CMX_FEED_KILL_SECONDS is closed at its last price: without prices the stops
 * cannot fire. The clock never starts before the entry or the engine start.
 */

process.env.TZ = process.env.TZ || "Asia/Calcutta";

const assert = require("assert");
const fs     = require("fs");
const path   = require("path");
const { staleFeed } = require("../src/services/commodityPaper");

const NOW = 1000000000;
const ago = (s) => NOW - s * 1000;

assert.strictEqual(staleFeed(120, NOW, ago(600), ago(5), ago(5)), null, "both prices alive: keep the trade");
assert.deepStrictEqual(staleFeed(120, NOW, ago(600), ago(120), ago(5)), { what: "future", secs: 120 }, "future quiet: kill");
assert.deepStrictEqual(staleFeed(120, NOW, ago(600), ago(5), ago(300)), { what: "option", secs: 300 }, "option quiet: kill");
assert.strictEqual(staleFeed(120, NOW, ago(30), ago(600), ago(600)), null, "old quotes from before the entry do not count");
assert.deepStrictEqual(staleFeed(120, NOW, ago(200), undefined, ago(5)), { what: "future", secs: 200 }, "never had a quote: clock runs from the entry");
assert.strictEqual(staleFeed(0, NOW, ago(9999), ago(9999), ago(9999)), null, "0 = off");

const src = fs.readFileSync(path.join(__dirname, "../src/services/commodityPaper.js"), "utf-8");
assert(/staleFeed\(c\.feedKillSec,[\s\S]{0,200}?await exit\(`No live/.test(src), "the engine loop must act on the rule");
const settings = fs.readFileSync(path.join(__dirname, "../src/routes/settings.js"), "utf-8");
assert(settings.includes('key: "CMX_FEED_KILL_SECONDS"'), "the setting must be in the Settings UI");

console.log("✅ cmxFeedKill regression passed");
process.exit(0);

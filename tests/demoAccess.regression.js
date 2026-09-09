#!/usr/bin/env node
/**
 * DEMO-LOGIN INVARIANTS — the read-only session must stay read-only
 *
 *   node tests/demoAccess.regression.js
 *
 * Zero dependencies, zero framework, exits non-zero on failure. Nothing here opens
 * a socket, a broker connection or a session.
 *
 * The rule this suite defends: DEMO_LOGIN_SECRET opens a session that can LOOK at
 * the app and change NOTHING. That guarantee is worth exactly as much as its
 * weakest path, and the app mounts ~70 routers that each own their own writes —
 * so the policy is deny-by-default and this suite is what keeps it that way.
 *
 * GROUP 4 is the one that matters long-term: it asserts the demo gate is wired
 * BEFORE the route mounts in app.js. A gate that runs after a router has already
 * answered is not a gate, and the failure is invisible in normal use — the owner
 * login behaves identically either way.
 */

const assert = require("assert");
const fs     = require("fs");
const path   = require("path");

const SRC  = path.join(__dirname, "../src");
const read = (rel) => fs.readFileSync(path.join(SRC, rel), "utf-8");
// Prose that merely mentions code is not code — assertions run on decommented text.
const decomment = (s) => s.split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

let pass = 0, fail = 0;
function section(t) { console.log(`\n${t}`); }
function check(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); pass++; }
  catch (e) { console.log(`  ❌ ${name}\n       ${e.message}`); fail++; }
}

const demo = require("../src/utils/demoMode");

const allowed = (m, p) => demo.allows(m, p).ok;

// ─────────────────────────────────────────────────────────────────────────────
section("GROUP 1 — the demo login only exists when it is safe to exist");
// ─────────────────────────────────────────────────────────────────────────────
function withEnv(env, fn) {
  const saved = {};
  for (const k of Object.keys(env)) { saved[k] = process.env[k]; process.env[k] = env[k]; }
  try { return fn(); }
  finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
}

check("off by default", () => {
  withEnv({ DEMO_LOGIN_ENABLED: "", DEMO_LOGIN_SECRET: "", LOGIN_SECRET: "owner" }, () => {
    assert.strictEqual(demo.isEnabled(), false);
  });
});

check("refuses to enable without a demo password", () => {
  withEnv({ DEMO_LOGIN_ENABLED: "true", DEMO_LOGIN_SECRET: "", LOGIN_SECRET: "owner" }, () => {
    assert.strictEqual(demo.isEnabled(), false);
  });
});

check("refuses to enable when the owner login is open (no LOGIN_SECRET)", () => {
  // With no login gate every page is already public — a "read-only session"
  // beside open access would be a false assurance, not a restriction.
  withEnv({ DEMO_LOGIN_ENABLED: "true", DEMO_LOGIN_SECRET: "demo", LOGIN_SECRET: "" }, () => {
    assert.strictEqual(demo.isEnabled(), false);
  });
});

check("refuses to enable when demo and owner passwords are the same", () => {
  // Otherwise the owner's own login silently becomes read-only.
  withEnv({ DEMO_LOGIN_ENABLED: "true", DEMO_LOGIN_SECRET: "same", LOGIN_SECRET: "same" }, () => {
    assert.strictEqual(demo.isEnabled(), false);
  });
});

check("demo cookie token can never collide with the owner's", () => {
  const crypto = require("crypto");
  withEnv({ DEMO_LOGIN_SECRET: "owner" }, () => {
    const ownerToken = crypto.createHash("sha256").update("owner").digest("hex");
    assert.notStrictEqual(demo.token(), ownerToken,
      "a demo password equal to the owner's would mint the owner's cookie");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
section("GROUP 2 — nothing a demo session sends can change state");
// ─────────────────────────────────────────────────────────────────────────────
for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
  check(`${method} is refused outright`, () => {
    assert.strictEqual(allowed(method, "/orb-paper/status"), false,
      `${method} reached a router — the demo session is not read-only`);
  });
}

const ACTION_PATHS = [
  "/ema_rsi_st-paper/start",     // start a paper session
  "/orb-live/stop",              // stop a LIVE session
  "/pa-paper/exit",              // exit an open position
  "/orb-paper/reset",            // wipe a session's trades
  "/settings/save",              // rewrite .env
  "/settings/env",               // read .env unmasked (a GET that hands out every secret)
  "/token-sync/tokens",          // hand out a live broker token
  "/api/holidays/refresh",
  "/swing-scanner/order",        // places a REAL order, no dry-run gate
  "/trade-logs/download-all",    // bulk data export
  "/backup/download",
  "/cache-files/delete-all",
  "/monitor/action/restart",
];
for (const p of ACTION_PATHS) {
  check(`GET ${p} is refused`, () => {
    assert.strictEqual(allowed("GET", p), false,
      `${p} is reachable in the demo — an action segment slipped through the policy`);
  });
}

const OWNER_ONLY_PAGES = ["/settings", "/token-sync", "/login-logs", "/cache-files",
                          "/sync", "/monitor", "/swing-scanner", "/tracker/status", "/logs"];
for (const p of OWNER_ONLY_PAGES) {
  check(`${p} is owner-only`, () => {
    assert.strictEqual(allowed("GET", p), false, `${p} is visible to the demo`);
  });
}

check("an unknown route is refused, not allowed (deny-by-default)", () => {
  // The whole point of the design: a page added next year is missing from the
  // demo until someone lists it — it is never silently exposed.
  assert.strictEqual(allowed("GET", "/some-page-invented-later"), false);
  assert.strictEqual(allowed("GET", "/api/whatever-comes-next"), false);
});

// ─────────────────────────────────────────────────────────────────────────────
section("GROUP 3 — but the demo still SHOWS the product");
// ─────────────────────────────────────────────────────────────────────────────
const DEMO_PAGES = [
  "/", "/realtime", "/realtime/capital", "/all-backtest", "/all-backtest/stats",
  "/consolidation", "/consolidation/data", "/consolidation-report", "/edge-analytics",
  "/advisor", "/replay", "/replay/list", "/trade-logs", "/trade-logs/view",
  "/docs", "/docs/file/pa-guide.html", "/oi-monitor", "/api/session-active",
  "/auth/status", "/auth/socket-health", "/backup/status", "/logout",
];
for (const p of DEMO_PAGES) {
  check(`${p} is part of the demo`, () => {
    assert.strictEqual(allowed("GET", p), true, `${p} is refused — the demo would look broken`);
  });
}

check("every strategy's paper + backtest pages are demo-eligible by shape", () => {
  // Matched by route SHAPE, not by name, so a strategy added later joins the
  // demo the moment it is mounted — no list to remember to extend.
  for (const p of ["/orb-paper/status", "/bn-pivot-rsi-st-paper/status/data",
                   "/ema_rsi_st_v2-paper/history", "/trend-day-scalp-backtest",
                   "/a-brand-new-strategy-paper/status"]) {
    assert.strictEqual(allowed("GET", p), true, `${p} should be demo-eligible`);
  }
});

check("live pages follow DEMO_SHOW_LIVE", () => {
  const LIVE = ["/orb-live/status", "/pa-live-harness", "/live-consolidation", "/pnl-history"];
  withEnv({ DEMO_SHOW_LIVE: "false" }, () => {
    for (const p of LIVE) assert.strictEqual(allowed("GET", p), false, `${p} leaked with DEMO_SHOW_LIVE off`);
  });
  withEnv({ DEMO_SHOW_LIVE: "true" }, () => {
    for (const p of LIVE) assert.strictEqual(allowed("GET", p), true, `${p} stayed hidden with DEMO_SHOW_LIVE on`);
  });
});

check("turning live pages ON never turns actions on", () => {
  withEnv({ DEMO_SHOW_LIVE: "true" }, () => {
    assert.strictEqual(allowed("GET", "/orb-live/start"), false);
    assert.strictEqual(allowed("POST", "/orb-live/exit"), false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
section("GROUP 4 — the gate is wired where it can actually gate");
// ─────────────────────────────────────────────────────────────────────────────
const appSrc = decomment(read("app.js"));

check("the demo gate is registered before the route mounts", () => {
  const gateAt  = appSrc.indexOf("demoMode.isDemo()");
  const routeAt = appSrc.indexOf('app.use("/auth"');
  assert.ok(gateAt > 0, "app.js never consults demoMode.isDemo() — nothing enforces the demo");
  assert.ok(routeAt > 0, "could not find the route block in app.js");
  assert.ok(gateAt < routeAt,
    "the demo gate runs AFTER the routers are mounted — a router would answer first");
});

check("the login gate puts demo requests into the demo context", () => {
  assert.ok(/demoMode\.runAsDemo\(true/.test(appSrc),
    "the login gate never enters demoMode's request context — the sidebar would render as owner");
});

check("the demo password is checked after the owner password", () => {
  const ownerAt = appSrc.indexOf("req.body.password === secret");
  const demoAt  = appSrc.indexOf("req.body.password === demoMode.demoSecret()");
  assert.ok(ownerAt > 0 && demoAt > 0, "the login route checks only one password");
  assert.ok(ownerAt < demoAt,
    "the demo password is checked first — a mis-set demo secret could downgrade the owner's login");
});

check("the demo lands on a page it is allowed to open", () => {
  // With UI_SHOW_DASHBOARD off, "/" redirects to /settings — which the demo is
  // refused, so a stakeholder's very first click would be a refusal page.
  assert.ok(/demoMode\.isDemo\(\)\) return res\.redirect\("\/realtime"\)/.test(appSrc),
    'the "/" handler sends a demo session to /settings — its landing page must be demo-eligible');
});

check("owner-only banners are not rendered for a demo session", () => {
  // Two of them link into routes the demo cannot open (broker re-login, backup
  // download), so leaving them in puts dead links in the stakeholder's face.
  const nav = decomment(read("utils/sharedNav.js"));
  assert.ok(/const operatorBanners = isDemoSession \? '' :/.test(nav),
    "the socket / Telegram / backup banners still render in a demo session");
});

check("the sidebar hides what the policy refuses", () => {
  const nav = decomment(read("utils/sharedNav.js"));
  assert.ok(/demoMode\.allowsPage\(/.test(nav),
    "sharedNav renders menu items without consulting the demo policy — dead links in the demo");
  assert.ok(/isDemoSession[\s\S]{0,400}sb-demo-pill/.test(nav),
    "the sidebar still renders its Start/Stop/Exit buttons for a demo session");
});

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

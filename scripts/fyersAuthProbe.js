#!/usr/bin/env node
/**
 * fyersAuthProbe.js — exchange ONE fresh Fyers auth_code and print exactly what
 * Fyers says, with each candidate app-id form tried in turn.
 *
 * Why this exists: a failed login only ever showed {"code":-99,"message":
 * "internal server error"}, which is Fyers' generic failure and names no input.
 * Guessing from it wasted hours. This asks Fyers directly and prints the raw
 * answer for each variant, so the reply itself says which pairing works.
 *
 * An auth_code is single-use and short-lived, so grab a FRESH one and run this
 * within a minute:
 *
 *   1. open  https://<host>/auth/login  and log in at Fyers
 *   2. copy the auth_code=... value out of the URL you land on
 *   3. node scripts/fyersAuthProbe.js "<auth_code>"
 *
 * Secrets are never printed — only lengths and the first bytes of a hash.
 */

require("dotenv").config();
const crypto = require("crypto");
const https  = require("https");

const APP_ID = String(process.env.APP_ID || "").trim();
const SECRET = String(process.env.SECRET_KEY || "").trim();
const code   = String(process.argv[2] || "").trim();

if (!code) {
  console.error("usage: node scripts/fyersAuthProbe.js \"<auth_code>\"");
  process.exit(2);
}
if (!APP_ID || !SECRET) {
  console.error(`APP_ID set: ${!!APP_ID}, SECRET_KEY set: ${!!SECRET} — both are required.`);
  process.exit(2);
}
// Hashing the display mask would produce a confident, meaningless answer —
// exactly the wrong outcome for a tool whose job is to end the guessing.
for (const [name, val] of [["APP_ID", APP_ID], ["SECRET_KEY", SECRET]]) {
  if (/^[*•]+$/.test(val)) {
    console.error(`${name} is "${val}" — the masked placeholder from the VIEW .env listing, `
      + `not a real credential. Set the real value before probing.`);
    process.exit(2);
  }
}

console.log(`app_id      : ${APP_ID}`);
console.log(`secret len  : ${SECRET.length}`);
console.log(`code len    : ${code.length}`);

// The auth_code is a JWT; its payload names the app it was issued for.
try {
  const payload = JSON.parse(Buffer.from(code.split(".")[1], "base64").toString("utf8"));
  console.log(`code app_id : ${payload.app_id}`);
  if (payload.exp) {
    const left = payload.exp - Math.floor(Date.now() / 1000);
    console.log(`code expiry : ${left}s ${left < 0 ? "— ALREADY EXPIRED, get a fresh one" : "left"}`);
  }
} catch (_) {
  console.log("code app_id : (could not decode — not a JWT?)");
}

function exchange(appIdForHash) {
  const hash = crypto.createHash("sha256").update(`${appIdForHash}:${SECRET}`).digest("hex");
  const body = JSON.stringify({ grant_type: "authorization_code", code, appIdHash: hash });
  return new Promise(resolve => {
    const req = https.request({
      hostname: "api-t1.fyers.in",
      path: "/api/v3/validate-authcode",
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      timeout: 20000,
    }, res => {
      let out = "";
      res.on("data", d => out += d);
      res.on("end", () => resolve({ status: res.statusCode, body: out, hash }));
    });
    req.on("timeout", () => { req.destroy(); resolve({ status: 0, body: "timeout", hash }); });
    req.on("error", e => resolve({ status: 0, body: e.message, hash }));
    req.end(body);
  });
}

(async () => {
  // Same code, different app-id spelling in the hash. Whichever Fyers accepts
  // is the correct pairing; if both fail identically the code or the secret is
  // the problem, not the spelling.
  const variants = [APP_ID];
  const bare = APP_ID.replace(/-\d+$/, "");
  if (bare !== APP_ID) variants.push(bare);

  for (const v of variants) {
    const r = await exchange(v);
    console.log(`\nhash from "${v}:<secret>" (${r.hash.slice(0, 16)}…)`);
    console.log(`  HTTP ${r.status}: ${r.body}`);
    try {
      if (JSON.parse(r.body).s === "ok") {
        console.log("  ^ THIS PAIRING WORKS — the token exchange succeeded.");
        break;
      }
    } catch (_) { /* non-JSON body already printed */ }
  }

  console.log(`
Reading the result:
  s:"ok"        the pairing works.
  -437          the code is stale/used — fetch a fresh one and retry at once.
  -99           generic Fyers failure. If BOTH variants give this with a fresh
                code, the App ID / Secret ID pair does not belong together, or
                the fault is on Fyers' side.`);
})();

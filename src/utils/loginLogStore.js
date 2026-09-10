/**
 * loginLogStore.js — Persists login attempts to disk
 * ─────────────────────────────────────────────────────────────────────────────
 * Stores IP, attempted password, user-agent, timestamp, and geolocation for
 * every failed try AND every successful demo (read-only) sign-in — entries
 * carry `result`: "failed" | "demo".
 */

const fs   = require("fs");
const path = require("path");

const DATA_DIR  = path.join(__dirname, "../../data");
const LOG_FILE  = path.join(DATA_DIR, "login_attempts.json");

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadAll() {
  ensureDir();
  if (!fs.existsSync(LOG_FILE)) return [];
  try {
    const all = JSON.parse(fs.readFileSync(LOG_FILE, "utf-8"));
    if (!Array.isArray(all)) return [];
    // Callers group and filter on `result`, so guarantee the contract here:
    // every element is an object and every object carries a result. A row
    // truncated by a half-written file must not 500 the viewer, and entries
    // written before demo logins were logged were all failed tries.
    return all
      .filter(e => e && typeof e === "object")
      .map(e => (e.result ? e : { ...e, result: "failed" }));
  } catch {
    return [];
  }
}

// Retention cap: this file is written synchronously on the login request path,
// and an internet-exposed login gets scanned continuously by bots. Without a cap
// the array — and the whole-file parse+rewrite each failed attempt does — grows
// unbounded (tens of MB of sync I/O per probe over time). Keep newest 2000.
const MAX_ENTRIES = 2000;
// ...but a plain newest-2000 tail-drop lets that same bot flood evict every demo
// sign-in, which is the audit trail for the one password that leaves the
// building — rare rows, drowned by noise, exactly the ones worth keeping. So
// reserve part of the budget for them: failed rows are trimmed first, and demo
// rows survive up to this many. The TOTAL stays MAX_ENTRIES, so the sync
// read+write this cap exists to bound does not grow.
const MAX_DEMO = 500;

/** Newest-first in, newest-first out, at most MAX_ENTRIES with demo rows spared. */
function trim(entries) {
  if (entries.length <= MAX_ENTRIES) return entries;
  let demoBudget = Math.min(MAX_DEMO, entries.reduce((n, e) => n + (e.result === "demo" ? 1 : 0), 0));
  let failBudget = MAX_ENTRIES - demoBudget;
  const out = [];
  for (const e of entries) { // relies on newest-first, so the oldest fall off the tail
    if (e.result === "demo") { if (demoBudget > 0) { demoBudget--; out.push(e); } }
    else if (failBudget > 0) { failBudget--; out.push(e); }
  }
  return out;
}

function save(entries) {
  ensureDir();
  fs.writeFileSync(LOG_FILE, JSON.stringify(trim(entries), null, 2));
}

function addEntry(entry) {
  const all = loadAll();
  all.unshift(entry); // newest first
  save(all);
}

function clearAll() {
  save([]);
}

// `trim` is exported for the retention regression test, which asserts a bot
// flood cannot evict demo sign-ins — testing it through addEntry would mean
// overwriting the real login log to do it.
module.exports = { loadAll, addEntry, clearAll, trim };

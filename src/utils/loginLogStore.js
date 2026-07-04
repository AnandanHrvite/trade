/**
 * loginLogStore.js — Persists failed login attempts to disk
 * ─────────────────────────────────────────────────────────────────────────────
 * Stores IP, attempted password, user-agent, timestamp, and geolocation.
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
    return JSON.parse(fs.readFileSync(LOG_FILE, "utf-8"));
  } catch {
    return [];
  }
}

// Retention cap: this file is written synchronously on the login request path,
// and an internet-exposed login gets scanned continuously by bots. Without a cap
// the array — and the whole-file parse+rewrite each failed attempt does — grows
// unbounded (tens of MB of sync I/O per probe over time). Keep newest 2000.
const MAX_ENTRIES = 2000;

function save(entries) {
  ensureDir();
  if (entries.length > MAX_ENTRIES) entries.length = MAX_ENTRIES; // newest-first, drop oldest tail
  fs.writeFileSync(LOG_FILE, JSON.stringify(entries, null, 2));
}

function addEntry(entry) {
  const all = loadAll();
  all.unshift(entry); // newest first
  save(all);
}

function clearAll() {
  save([]);
}

module.exports = { loadAll, addEntry, clearAll };

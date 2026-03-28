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

function save(entries) {
  ensureDir();
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

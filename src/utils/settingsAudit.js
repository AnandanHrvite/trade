/**
 * Settings audit log — append-only JSONL of every settings value change.
 *
 * Each save through POST /settings/save (and any seeded historical change)
 * appends one line per key to ~/trading-data/settings-audit.jsonl with:
 *   { ts, key, from, to, action, source, ip, ua }
 *
 *   action: "add" (new key)  | "update" (value changed)  | "delete" (key removed)
 *   from:   prior value, or null for "add"
 *   to:     new value, or null for "delete"
 *   source: "ui" (POST /save) | "git:<sha>" (seeded from commit)
 *
 * Read with readAuditLog({ limit, since, key }) — newest first.
 */

const fs   = require("fs");
const path = require("path");
const os   = require("os");

const AUDIT_DIR  = path.join(os.homedir(), "trading-data");
const AUDIT_FILE = path.join(AUDIT_DIR, "settings-audit.jsonl");

// Retention: keep the newest N entries regardless of age. Age-based retention
// used to drop everything older than a few days, which wiped the history a user
// still wanted; a row cap bounds the file without depending on how long ago a
// change happened. Pruning runs on every append.
const DEFAULT_MAX_ENTRIES = 500;
function maxEntries() {
  const n = Number(process.env.SETTINGS_AUDIT_MAX_ENTRIES);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_MAX_ENTRIES;
}

try { fs.mkdirSync(AUDIT_DIR, { recursive: true }); } catch (_) {}

// Rewrite the audit file keeping only the newest `maxEntries()` lines.
function pruneOldEntries() {
  const cap = maxEntries();
  let raw = "";
  try { raw = fs.readFileSync(AUDIT_FILE, "utf-8"); }
  catch (err) { if (err.code !== "ENOENT") console.warn("[settingsAudit] prune read failed:", err.message); return; }

  const kept = [];
  let dropped = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try { JSON.parse(line); } catch (_) { dropped++; continue; } // drop malformed
    kept.push(line);
  }
  if (kept.length > cap) {
    dropped += kept.length - cap;
    kept.splice(0, kept.length - cap); // file is append-order, so oldest are first
  }
  if (dropped === 0) return;
  try {
    fs.writeFileSync(AUDIT_FILE, kept.length ? kept.join("\n") + "\n" : "");
  } catch (err) {
    console.warn("[settingsAudit] prune write failed:", err.message);
  }
}

// The audit log is written to disk in plaintext and rendered in the Settings
// audit view, so a credential must never reach it. Record that the key changed
// — never what it changed to or from.
const SECRET_KEY_RE = /(SECRET|TOKEN|PASSWORD|API_KEY|ACCESS)/i;

function auditValue(key, value) {
  if (value === null || value === undefined) return value;
  return SECRET_KEY_RE.test(key) ? "<redacted>" : value;
}

function diffEntries(prevEnv, updates, deleteKeys) {
  const out = [];
  const ts  = new Date().toISOString();
  for (const [key, to] of Object.entries(updates || {})) {
    const from = key in prevEnv ? prevEnv[key] : null;
    if (from === to) continue;
    out.push({
      ts, key,
      from: auditValue(key, from),
      to:   auditValue(key, to),
      action: from === null ? "add" : "update",
    });
  }
  for (const key of deleteKeys || []) {
    if (!(key in prevEnv)) continue;
    out.push({ ts, key, from: auditValue(key, prevEnv[key]), to: null, action: "delete" });
  }
  return out;
}

function appendEntries(entries, meta) {
  if (!entries || entries.length === 0) return;
  const lines = entries.map(e => JSON.stringify({ ...e, ...meta })).join("\n") + "\n";
  try {
    fs.appendFileSync(AUDIT_FILE, lines);
  } catch (err) {
    console.warn("[settingsAudit] failed to write log:", err.message);
  }
  pruneOldEntries();
}

function logSave({ prevEnv, updates, deleteKeys, req, note }) {
  const entries = diffEntries(prevEnv, updates, deleteKeys);
  if (entries.length === 0) return 0;
  const cleanNote = typeof note === "string" ? note.trim().slice(0, 500) : "";
  const meta = {
    source: "ui",
    ip: (req && (req.ip || req.connection?.remoteAddress)) || null,
    ua: (req && req.get && req.get("user-agent")) || null,
    ...(cleanNote ? { note: cleanNote } : {}),
  };
  appendEntries(entries, meta);
  return entries.length;
}

function readAuditLog(opts = {}) {
  const { limit = 500, since = null, key = null, action = null } = opts;
  let raw = "";
  try { raw = fs.readFileSync(AUDIT_FILE, "utf-8"); }
  catch (err) { if (err.code !== "ENOENT") console.warn("[settingsAudit] read failed:", err.message); return []; }

  const all = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try { all.push(JSON.parse(line)); } catch (_) { /* skip malformed */ }
  }
  // Cap at the same row limit the file is pruned to, so a file that has grown
  // past the cap between prunes still reads back the newest N.
  let filtered = all.slice(-maxEntries());
  if (since)  filtered = filtered.filter(e => e.ts >= since);
  if (key)    filtered = filtered.filter(e => e.key === key || e.key.includes(key));
  if (action) filtered = filtered.filter(e => e.action === action);
  filtered.reverse();
  if (limit > 0) filtered = filtered.slice(0, limit);
  return filtered;
}

module.exports = {
  AUDIT_FILE,
  diffEntries,
  appendEntries,
  logSave,
  readAuditLog,
};

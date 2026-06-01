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

// Retention: only the last week of settings changes is kept; older entries are
// pruned from the file (on every append) and never returned by readAuditLog.
const RETENTION_DAYS = Number(process.env.SETTINGS_AUDIT_RETAIN_DAYS || 7);

try { fs.mkdirSync(AUDIT_DIR, { recursive: true }); } catch (_) {}

function retentionCutoff() {
  return new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

// Rewrite the audit file dropping any entry older than the retention cutoff.
function pruneOldEntries() {
  let raw = "";
  try { raw = fs.readFileSync(AUDIT_FILE, "utf-8"); }
  catch (err) { if (err.code !== "ENOENT") console.warn("[settingsAudit] prune read failed:", err.message); return; }

  const cutoff = retentionCutoff();
  const kept = [];
  let dropped = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch (_) { continue; } // drop malformed
    if (obj.ts && obj.ts < cutoff) { dropped++; continue; }
    kept.push(line);
  }
  if (dropped === 0) return;
  try {
    fs.writeFileSync(AUDIT_FILE, kept.length ? kept.join("\n") + "\n" : "");
  } catch (err) {
    console.warn("[settingsAudit] prune write failed:", err.message);
  }
}

function diffEntries(prevEnv, updates, deleteKeys) {
  const out = [];
  const ts  = new Date().toISOString();
  for (const [key, to] of Object.entries(updates || {})) {
    const from = key in prevEnv ? prevEnv[key] : null;
    if (from === to) continue;
    out.push({ ts, key, from, to, action: from === null ? "add" : "update" });
  }
  for (const key of deleteKeys || []) {
    if (!(key in prevEnv)) continue;
    out.push({ ts, key, from: prevEnv[key], to: null, action: "delete" });
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
  // Never surface entries older than the retention window, even if the file
  // still holds them (e.g. before the next append triggers a prune).
  const cutoff = retentionCutoff();
  let filtered = all.filter(e => !e.ts || e.ts >= cutoff);
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

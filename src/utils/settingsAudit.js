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

try { fs.mkdirSync(AUDIT_DIR, { recursive: true }); } catch (_) {}

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
}

function logSave({ prevEnv, updates, deleteKeys, req }) {
  const entries = diffEntries(prevEnv, updates, deleteKeys);
  if (entries.length === 0) return 0;
  const meta = {
    source: "ui",
    ip: (req && (req.ip || req.connection?.remoteAddress)) || null,
    ua: (req && req.get && req.get("user-agent")) || null,
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
  let filtered = all;
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

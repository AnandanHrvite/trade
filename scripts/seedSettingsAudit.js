#!/usr/bin/env node
/**
 * One-shot seeder: reconstructs today's settings value changes from
 * commits that touched .env.example and appends them to the audit log.
 *
 * Run from inside the trade/ git repo:
 *   node /tmp/seed-settings-audit.js
 */

const { execFileSync } = require("child_process");
const fs           = require("fs");
const path         = require("path");
const os           = require("os");

const REPO  = process.cwd();
const SINCE = process.env.SEED_SINCE || "2026-04-29 00:00";
const UNTIL = process.env.SEED_UNTIL || "2026-04-30 00:00";
const TARGET_FILE = ".env.example";
const AUDIT_FILE  = path.join(os.homedir(), "trading-data", "settings-audit.jsonl");

fs.mkdirSync(path.dirname(AUDIT_FILE), { recursive: true });

function git(...args) {
  return execFileSync("git", args, { cwd: REPO, encoding: "utf-8" });
}

function parseEnvText(text) {
  const out = {};
  if (!text) return out;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1);
    // strip trailing inline comment ("VAL   # comment") — split on whitespace+#
    const hashIdx = val.search(/\s+#/);
    if (hashIdx !== -1) val = val.slice(0, hashIdx);
    out[key] = val.trim();
  }
  return out;
}

function showAt(sha, file) {
  try { return git("show", `${sha}:${file}`); } catch (_) { return ""; }
}

const log = git(
  "log",
  `--since=${SINCE}`,
  `--until=${UNTIL}`,
  "--reverse",
  "--pretty=format:%H|%cI",
  "--",
  TARGET_FILE
).trim();
if (!log) {
  console.log(`[seed] No ${TARGET_FILE} changes in window ${SINCE} → ${UNTIL}`);
  process.exit(0);
}

const commits = log.split("\n").map(line => {
  const [sha, ts] = line.split("|");
  return { sha, ts };
});

console.log(`[seed] Found ${commits.length} commit(s) touching ${TARGET_FILE}`);

const lines = [];
let totalChanges = 0;

for (const { sha, ts } of commits) {
  let parentSha;
  try { parentSha = git("rev-parse", `${sha}^`).trim(); } catch (_) { parentSha = null; }

  const oldText = parentSha ? showAt(parentSha, TARGET_FILE) : "";
  const newText = showAt(sha, TARGET_FILE);
  const oldEnv = parseEnvText(oldText);
  const newEnv = parseEnvText(newText);

  const subject = git("log", "-1", "--pretty=format:%s", sha).trim();
  const author  = git("log", "-1", "--pretty=format:%an", sha).trim();

  let commitChanges = 0;
  const allKeys = new Set([...Object.keys(oldEnv), ...Object.keys(newEnv)]);
  for (const key of allKeys) {
    const from = oldEnv[key];
    const to   = newEnv[key];
    if (from === to) continue;

    let action;
    if (from === undefined) action = "add";
    else if (to === undefined) action = "delete";
    else action = "update";

    const entry = {
      ts,
      key,
      from: from === undefined ? null : from,
      to:   to   === undefined ? null : to,
      action,
      source: `git:${sha.slice(0,7)}`,
      file:   TARGET_FILE,
      commit_subject: subject,
      author,
    };
    lines.push(JSON.stringify(entry));
    commitChanges++;
  }
  console.log(`[seed]   ${sha.slice(0,7)} ${ts}  ${commitChanges} change(s)  — ${subject}`);
  totalChanges += commitChanges;
}

if (lines.length === 0) {
  console.log("[seed] No KEY=VALUE differences across the diffs.");
  process.exit(0);
}

fs.appendFileSync(AUDIT_FILE, lines.join("\n") + "\n");
console.log(`[seed] Appended ${totalChanges} entries to ${AUDIT_FILE}`);

/**
 * logArchive.js — Disk archive for the server log stream
 * ──────────────────────────────────────────────────────────────────────────
 * Why: logger.js keeps only a 5 000-entry in-memory ring, so the Server Logs
 * tab loses everything on a PM2 restart and can never show yesterday. This
 * module mirrors every captured console entry into one JSONL file per IST day
 * under ~/trading-data/server_logs/ and prunes files older than
 * SERVER_LOG_RETAIN_DAYS (default 7 → today + the last 6 days).
 *
 * Design constraints:
 *  - console.log runs on the tick hot path → NO sync I/O per entry. Entries
 *    are buffered and flushed on a 2 s timer (or when the buffer fills).
 *  - This module must NEVER call console.* — logger.js has already replaced
 *    console, so a log here would recurse straight back into append().
 *    Diagnostics go to process.stderr directly.
 *  - Failures are non-fatal: a broken archive must not take down trading.
 */

const fs   = require("fs");
const path = require("path");
const os   = require("os");

const ROOT_DIR     = path.join(os.homedir(), "trading-data", "server_logs");
const ENABLED      = String(process.env.SERVER_LOG_ARCHIVE_ENABLED || "true").toLowerCase() !== "false";
const RETAIN_DAYS  = clampInt(process.env.SERVER_LOG_RETAIN_DAYS, 7, 1, 90);
const MAX_DAY_MB   = clampInt(process.env.SERVER_LOG_MAX_MB, 200, 5, 2000);
const MAX_DAY_BYTES = MAX_DAY_MB * 1024 * 1024;

const FLUSH_MS      = 2000;
const FLUSH_ENTRIES = 500;   // flush early on a burst instead of waiting for the timer
const MAX_BUFFER    = 20000; // hard cap — drop oldest if disk writes keep failing

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

let buffer      = [];
let flushTimer  = null;
let flushing    = false;
let dropped     = 0;                 // entries lost to buffer overflow since last notice
const dayBytes  = new Map();         // "YYYY-MM-DD" → bytes written today (lazily seeded from disk)
const overCap   = new Set();         // days that hit MAX_DAY_BYTES (stop appending, warn once)
let readCache   = null;              // { date, key, entries } — one parsed day, past days are immutable

function clampInt(raw, def, min, max) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

function warn(msg) {
  try { process.stderr.write(`[logArchive] ${msg}\n`); } catch (_) {}
}

// IST "YYYY-MM-DD" for a unix-ms timestamp (or now).
function istDateString(unixMs) {
  const ist = new Date((typeof unixMs === "number" ? unixMs : Date.now()) + 19800000);
  const m = ist.getUTCMonth() + 1;
  const d = ist.getUTCDate();
  return `${ist.getUTCFullYear()}-${m < 10 ? "0" : ""}${m}-${d < 10 ? "0" : ""}${d}`;
}

// logger.js stamps entry.date as "DD/MM/YYYY" — reuse it so an entry always
// lands in the file for the day it was actually written.
function dateKeyOf(entry) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(entry && entry.date || "");
  return m ? `${m[3]}-${m[2]}-${m[1]}` : istDateString();
}

function filePathFor(date) {
  if (!DATE_RE.test(date)) throw new Error(`logArchive: bad date "${date}"`);
  return path.join(ROOT_DIR, `${date}.jsonl`);
}

if (ENABLED) {
  try { fs.mkdirSync(ROOT_DIR, { recursive: true }); }
  catch (err) { warn(`cannot create ${ROOT_DIR}: ${err.message}`); }
}

// ── Write path ───────────────────────────────────────────────────────────────

function append(entry) {
  if (!ENABLED) return;
  buffer.push(entry);
  if (buffer.length > MAX_BUFFER) {
    dropped += buffer.length - MAX_BUFFER;
    buffer.splice(0, buffer.length - MAX_BUFFER);
  }
  if (buffer.length >= FLUSH_ENTRIES) { flush(); return; }
  if (!flushTimer) {
    flushTimer = setTimeout(flush, FLUSH_MS);
    if (flushTimer.unref) flushTimer.unref(); // never hold the process open
  }
}

// Group the buffer into one payload per IST day (a flush can straddle midnight).
function drain() {
  const byDate = new Map();
  for (const e of buffer) {
    const key = dateKeyOf(e);
    let line;
    try { line = JSON.stringify(e) + "\n"; } catch (_) { continue; }
    byDate.set(key, (byDate.get(key) || "") + line);
  }
  buffer = [];
  return byDate;
}

function currentBytes(date) {
  if (dayBytes.has(date)) return dayBytes.get(date);
  let size = 0;
  try { size = fs.statSync(filePathFor(date)).size; } catch (_) { size = 0; }
  dayBytes.set(date, size);
  return size;
}

// Returns the payload to write, or "" when the day is over its size cap.
function admit(date, payload) {
  const before = currentBytes(date);
  if (before >= MAX_DAY_BYTES) {
    if (!overCap.has(date)) {
      overCap.add(date);
      warn(`${date} hit the ${MAX_DAY_MB} MB cap — further entries are not archived (memory view unaffected)`);
    }
    return "";
  }
  dayBytes.set(date, before + Buffer.byteLength(payload));
  return payload;
}

function flush(sync) {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  if (!ENABLED || !buffer.length) return;
  // An async flush is already in flight — re-arm the timer rather than returning
  // empty-handed, so a quiet period can't strand the buffered tail on disk.
  if (flushing && !sync) {
    flushTimer = setTimeout(flush, FLUSH_MS);
    if (flushTimer.unref) flushTimer.unref();
    return;
  }

  if (dropped) { warn(`buffer overflow — dropped ${dropped} entries`); dropped = 0; }

  const byDate = drain();
  if (sync) {
    for (const [date, payload] of byDate) {
      const text = admit(date, payload);
      if (!text) continue;
      try { fs.appendFileSync(filePathFor(date), text); }
      catch (err) { warn(`sync write failed for ${date}: ${err.message}`); }
    }
    return;
  }

  flushing = true;
  let pending = byDate.size;
  if (!pending) { flushing = false; return; }
  for (const [date, payload] of byDate) {
    const text = admit(date, payload);
    if (!text) { if (--pending === 0) flushing = false; continue; }
    fs.appendFile(filePathFor(date), text, (err) => {
      // Deliberately not re-queued: a failing disk would grow the buffer forever.
      if (err) warn(`write failed for ${date}: ${err.message}`);
      if (--pending === 0) flushing = false;
    });
  }
}

// Last-chance flush so the tail of a session is not lost on shutdown.
process.on("exit", () => { try { flush(true); } catch (_) {} });

// ── Read path ────────────────────────────────────────────────────────────────

/** Archived days present on disk, newest first: [{ date, bytes }]. */
function listDates() {
  if (!ENABLED) return [];
  let names = [];
  try { names = fs.readdirSync(ROOT_DIR); }
  catch (_) { return []; }

  const out = [];
  for (const name of names) {
    const m = /^(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name);
    if (!m) continue;
    let bytes = 0;
    try { bytes = fs.statSync(path.join(ROOT_DIR, name)).size; } catch (_) {}
    out.push({ date: m[1], bytes });
  }
  return out.sort((a, b) => (a.date < b.date ? 1 : -1));
}

/**
 * Parsed entries for one archived day, oldest first.
 * Past-day files only ever grow while that day is current, so the single-slot
 * cache is keyed on size+mtime — a stale read is impossible.
 */
function readDay(date) {
  if (!ENABLED) return [];
  const fp = filePathFor(date);
  let st;
  try { st = fs.statSync(fp); } catch (_) { return []; }

  const key = `${st.size}:${st.mtimeMs}`;
  if (readCache && readCache.date === date && readCache.key === key) return readCache.entries;

  let text = "";
  try { text = fs.readFileSync(fp, "utf-8"); }
  catch (err) { warn(`read failed for ${date}: ${err.message}`); return []; }

  const entries = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try { entries.push(JSON.parse(line)); } catch (_) { /* truncated tail line */ }
  }
  readCache = { date, key, entries };
  return entries;
}

/** Delete archives older than RETAIN_DAYS (today counts as day 1). */
function prune(retainDays) {
  if (!ENABLED) return { kept: 0, deleted: 0 };
  const days   = Number.isFinite(retainDays) ? retainDays : RETAIN_DAYS;
  const cutoff = istDateString(Date.now() - (days - 1) * 86400000);
  let kept = 0, deleted = 0;

  for (const { date } of listDates()) {
    if (date < cutoff) {
      try { fs.unlinkSync(filePathFor(date)); deleted += 1; }
      catch (err) { warn(`prune failed for ${date}: ${err.message}`); }
      dayBytes.delete(date);
      overCap.delete(date);
      if (readCache && readCache.date === date) readCache = null;
    } else {
      kept += 1;
    }
  }
  return { kept, deleted, retainDays: days, cutoffDate: cutoff };
}

if (ENABLED) {
  prune();
  const t = setInterval(prune, 3600000); // hourly — catches the midnight rollover
  if (t.unref) t.unref();
}

module.exports = {
  append, flush, listDates, readDay, prune, istDateString, filePathFor,
  ROOT_DIR, RETAIN_DAYS, ENABLED,
};

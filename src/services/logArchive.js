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

// ── Line index (incremental) ─────────────────────────────────────────────────
// Instead of holding a parsed day (several times the file size), each cached
// day keeps a compact index: byte start + length of every line that parses as
// JSON, in two growable Uint32Arrays (8 bytes/entry). Today's file only ever
// grows, so a re-read scans just the bytes appended since the last one. An
// unterminated tail line (a write in flight) is never committed — it is
// re-examined on the next read — but it is still served if it already parses,
// matching what a naive whole-file parse would return. All reads are async and
// chunked so a large first scan never blocks the shared event loop.

const READ_CHUNK      = 1024 * 1024;  // bytes per fs read during a scan
const MAX_CACHED_DAYS = 2;            // today + one browsed past day

const indexCache = new Map();         // date → idx (Map order = LRU, newest last)
const indexLocks = new Map();         // date → in-flight refresh promise

function newIndex(ino) {
  return {
    ino, consumed: 0, size: 0, mtimeMs: 0, count: 0,
    starts: new Uint32Array(1024), lens: new Uint32Array(1024),
    tail: null,                       // { start, len } of a parseable unterminated last line
  };
}

function pushLine(idx, start, len) {
  if (idx.count === idx.starts.length) {
    const cap = idx.starts.length * 2;
    const s = new Uint32Array(cap); s.set(idx.starts); idx.starts = s;
    const l = new Uint32Array(cap); l.set(idx.lens);   idx.lens   = l;
  }
  idx.starts[idx.count] = start;
  idx.lens[idx.count]   = len;
  idx.count += 1;
}

function parses(buf, s, e) {
  if (e <= s) return false;
  try { JSON.parse(buf.toString("utf8", s, e)); return true; } catch (_) { return false; }
}

// Scan [idx.consumed, size) and commit every complete, parseable line.
async function scanFrom(fh, idx, size) {
  let carry = null;                   // bytes of a line split across chunks
  let carryStart = idx.consumed;
  let pos = idx.consumed;
  idx.tail = null;
  while (pos < size) {
    const want = Math.min(READ_CHUNK, size - pos);
    const chunk = Buffer.allocUnsafe(want);
    const { bytesRead } = await fh.read(chunk, 0, want, pos);
    if (!bytesRead) break;
    const buf  = carry ? Buffer.concat([carry, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead);
    const base = carry ? carryStart : pos;  // file offset of buf[0]
    let s = 0, nl;
    while ((nl = buf.indexOf(10, s)) !== -1) {
      if (parses(buf, s, nl)) pushLine(idx, base + s, nl - s);
      s = nl + 1;
    }
    idx.consumed = base + s;
    carry = s < buf.length ? Buffer.from(buf.subarray(s)) : null;
    carryStart = base + s;
    pos += bytesRead;
  }
  if (carry && parses(carry, 0, carry.length)) idx.tail = { start: carryStart, len: carry.length };
}

async function refreshIndex(date) {
  const fp = filePathFor(date);
  let st;
  try { st = await fs.promises.stat(fp); }
  catch (_) { indexCache.delete(date); return null; }

  let idx = indexCache.get(date);
  if (idx && idx.ino === st.ino && st.size === idx.size && st.mtimeMs === idx.mtimeMs) {
    indexCache.delete(date); indexCache.set(date, idx);   // LRU touch
    return idx;
  }
  // Shrunk, replaced or first read → rebuild; grew in place → scan the delta.
  if (!idx || idx.ino !== st.ino || st.size < idx.consumed) idx = newIndex(st.ino);

  let fh;
  try {
    fh = await fs.promises.open(fp, "r");
    await scanFrom(fh, idx, st.size);
  } catch (err) {
    warn(`read failed for ${date}: ${err.message}`);
    indexCache.delete(date);
    return null;
  } finally {
    if (fh) { try { await fh.close(); } catch (_) {} }
  }
  idx.size = st.size;
  idx.mtimeMs = st.mtimeMs;

  indexCache.delete(date);
  indexCache.set(date, idx);
  while (indexCache.size > MAX_CACHED_DAYS) indexCache.delete(indexCache.keys().next().value);
  return idx;
}

// One refresh per day at a time — concurrent requests share it.
function getIndex(date) {
  if (!ENABLED) return Promise.resolve(null);
  filePathFor(date);                  // validate before touching the lock map
  const inflight = indexLocks.get(date);
  if (inflight) return inflight;
  const p = refreshIndex(date).finally(() => indexLocks.delete(date));
  indexLocks.set(date, p);
  return p;
}

function totalOf(idx) { return idx ? idx.count + (idx.tail ? 1 : 0) : 0; }

// Parse entries [from, to) of an index, reading only their byte span.
async function readRange(date, idx, from, to) {
  const out = [];
  if (!idx || from >= to) return out;
  // Snapshot: a concurrent refresh may grow/reallocate the arrays or clear the
  // tail, but never rewrites slots below the old count, so these stay valid.
  const { count, starts, lens, tail } = idx;
  if (to > count + (tail ? 1 : 0)) to = count + (tail ? 1 : 0);
  const startOf = (i) => (i < count ? starts[i] : tail.start);
  const lenOf   = (i) => (i < count ? lens[i]   : tail.len);
  let fh;
  try {
    fh = await fs.promises.open(filePathFor(date), "r");
    let i = from;
    while (i < to) {
      // Batch consecutive entries into ≤ READ_CHUNK reads (a single huge line still reads whole).
      const spanStart = startOf(i);
      let j = i + 1;
      while (j < to && startOf(j) + lenOf(j) - spanStart <= READ_CHUNK) j++;
      const spanLen = startOf(j - 1) + lenOf(j - 1) - spanStart;
      const buf = Buffer.allocUnsafe(spanLen);
      let got = 0;
      while (got < spanLen) {
        const { bytesRead } = await fh.read(buf, got, spanLen - got, spanStart + got);
        if (!bytesRead) break;
        got += bytesRead;
      }
      for (let k = i; k < j; k++) {
        const s = startOf(k) - spanStart;
        try { out.push(JSON.parse(buf.toString("utf8", s, s + lenOf(k)))); } catch (_) {}
      }
      i = j;
    }
  } catch (err) {
    warn(`read failed for ${date}: ${err.message}`);
  } finally {
    if (fh) { try { await fh.close(); } catch (_) {} }
  }
  return out;
}

/** Number of entries in one archived day (incremental for today). */
async function countDay(date) {
  return totalOf(await getIndex(date));
}

/** One page of a day: { total, logs } — only the requested window is parsed. */
async function readDayPage(date, from, limit) {
  const idx   = await getIndex(date);
  const total = totalOf(idx);
  const logs  = from < total ? await readRange(date, idx, from, Math.min(total, from + limit)) : [];
  return { total, logs };
}

/** Every parsed entry for one archived day, oldest first (exports). Not cached. */
async function readDay(date) {
  const idx = await getIndex(date);
  return readRange(date, idx, 0, totalOf(idx));
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
      indexCache.delete(date);
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
  append, flush, listDates, readDay, readDayPage, countDay, prune, istDateString, filePathFor,
  ROOT_DIR, RETAIN_DAYS, ENABLED,
};

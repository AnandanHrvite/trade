/**
 * /mcp-data — read-only JSON feed for scripts/mcpTradeResults.js.
 *
 * Covers every strategy on every market (NIFTY, BANKNIFTY, COMMODITY) through
 * utils/tradeSources, which discovers modes rather than listing them — so a
 * new strategy appears here without editing this file.
 *
 *   GET /modes                     → { modes: [{ mode, market }] }
 *   GET /dates?mode=               → { mode, dates: [newest first] }
 *   GET /records?mode=&date=       → { mode, date, records: [trades + settings snapshots] }
 *   GET /settings?mode=            → { mode, settings: {KEY: value} } — the values in force now
 *
 * The rest of the Logs page, so the MCP sees everything the UI does:
 *   GET /skips?mode=&from=&to=&gate=&limit=          → Skip Logs tab (per-gate counts + rows)
 *   GET /audit?from=&to=&key=&action=&noted=&limit=  → Checkpoints & Settings Changes tab
 *   GET /login-logs?type=&limit=                     → Login Logs tab (typed passwords removed)
 *   GET /server-logs?date=&src=&level=&q=&from=&limit= → Server Logs tab (one IST day)
 *   GET /post-exit?mode=&from=&to=&limit=            → what each exit left on the table
 *
 * GET only and login-gated (not in the public-path list): settings are config.
 * A demo login cannot reach it either — demoMode is deny-by-default and
 * /mcp-data is not on its allowlist, which matters for the login/server logs.
 */

const express = require("express");
const fs = require("fs");
const path = require("path");
const tradeSources = require("../utils/tradeSources");
const tradeLogger = require("../utils/tradeLogger");
const skipLogger = require("../utils/skipLogger");
const settingsAudit = require("../utils/settingsAudit");
const loginLogStore = require("../utils/loginLogStore");
const postExitTracker = require("../utils/postExitTracker");
const logArchive = require("../services/logArchive");
const { logStore } = require("../services/logger");

const router = express.Router();
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function modeOf(req, res) {
  const mode = String(req.query.mode || "").toLowerCase();
  if (!tradeSources.isKnownMode(mode)) {
    res.status(400).json({ success: false, error: `unknown mode "${mode}"` });
    return null;
  }
  return mode;
}

/** Optional YYYY-MM-DD query param. Sends a 400 and returns false when malformed. */
function optDate(req, res, name) {
  const v = req.query[name];
  if (v == null || v === "") return null;
  if (!DATE_RE.test(String(v))) {
    res.status(400).json({ success: false, error: `bad ${name} "${v}" — expected YYYY-MM-DD` });
    return false;
  }
  return String(v);
}

/** Row cap: default when absent, clamped to [0, max]. An explicit 0 stays 0. */
function limitOf(req, def, max) {
  const raw = req.query.limit;
  if (raw == null || raw === "") return def;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? Math.min(Math.max(n, 0), max) : def;
}

const inRange = (d, from, to) => (!from || d >= from) && (!to || d <= to);

router.get("/modes", (_req, res) => {
  res.json({ success: true, modes: tradeSources.listModes() });
});

router.get("/dates", (req, res) => {
  const mode = modeOf(req, res);
  if (!mode) return;
  res.json({ success: true, mode, dates: tradeSources.listDates(mode) });
});

router.get("/records", (req, res) => {
  const mode = modeOf(req, res);
  if (!mode) return;
  const date = String(req.query.date || "");
  if (!DATE_RE.test(date)) return res.status(400).json({ success: false, error: "bad date" });
  res.json({ success: true, mode, date, records: tradeSources.readRecords(mode, date) });
});

router.get("/settings", (req, res) => {
  const mode = modeOf(req, res);
  if (!mode) return;
  const snap = tradeLogger.getSettingsSnapshot(mode);
  if (!snap) return res.status(404).json({ success: false, error: `no settings map for "${mode}"` });
  res.json({ success: true, mode, settings: snap.settings || snap });
});

// ── Skip Logs ────────────────────────────────────────────────────────────────
// Counts every row in range (per mode, per gate); returns at most `limit` rows,
// newest day first. A "strategy" row means no signal formed on that candle —
// a non-event — so pass gate= to see only real signals that a guard blocked.
router.get("/skips", (req, res) => {
  const skipModes = Object.keys(skipLogger.FILE_PREFIX_BY_MODE);
  const want = String(req.query.mode || "").toLowerCase();
  if (want && !skipModes.includes(want)) {
    return res.status(400).json({ success: false, error: `no skip log for mode "${want}". Skip-log modes: ${skipModes.join(", ")}` });
  }
  const from = optDate(req, res, "from"); if (from === false) return;
  const to = optDate(req, res, "to"); if (to === false) return;
  const gate = req.query.gate ? String(req.query.gate) : null;
  const cap = limitOf(req, 200, 2000);

  const byMode = {};
  const rows = [];
  let total = 0;
  for (const mode of want ? [want] : skipModes) {
    const dates = skipLogger.listDates(mode).map((d) => d.date).filter((d) => inRange(d, from, to));
    if (!dates.length) continue;
    const m = { days: dates.length, total: 0, byGate: {} };
    for (const date of dates) { // newest first
      for (const s of skipLogger.readDailySkips(mode, date)) {
        const g = s.gate || "(none)";
        m.byGate[g] = (m.byGate[g] || 0) + 1;
        m.total++;
        if (gate && g !== gate) continue;
        total++;
        if (rows.length < cap) rows.push({ mode, date, ...s });
      }
    }
    byMode[mode] = m;
  }
  res.json({ success: true, mode: want || null, from, to, gate, byMode, matched: total, returned: rows.length, skips: rows });
});

// ── Checkpoints & Settings Changes ───────────────────────────────────────────
router.get("/audit", (req, res) => {
  const from = optDate(req, res, "from"); if (from === false) return;
  const to = optDate(req, res, "to"); if (to === false) return;
  const cap = limitOf(req, 500, 5000);
  let entries = settingsAudit.readAuditLog({
    limit: 0, // filter first, cap after — the date range is applied below
    key: req.query.key ? String(req.query.key) : null,
    action: req.query.action ? String(req.query.action) : null,
  });
  // ts is ISO (UTC); compare on the IST day so a range matches the Logs page.
  const istDay = (ts) => {
    const t = Date.parse(ts);
    return Number.isFinite(t) ? skipLogger.istDateString(t) : "";
  };
  if (from || to) entries = entries.filter((e) => inRange(istDay(e.ts), from, to));
  if (String(req.query.noted || "") === "1") {
    entries = entries.filter((e) => typeof e.note === "string" && e.note.trim().length > 0);
  }
  res.json({ success: true, matched: entries.length, returned: Math.min(cap, entries.length), entries: entries.slice(0, cap) });
});

// ── Login Logs ───────────────────────────────────────────────────────────────
// The typed password is dropped: a failed try is often the owner's real
// password with a typo, and nothing an analysis needs depends on it.
router.get("/login-logs", (req, res) => {
  const all = loginLogStore.loadAll(); // newest first
  const counts = { all: all.length, failed: 0, demo: 0 };
  for (const l of all) (l.result === "demo" ? counts.demo++ : counts.failed++);
  const type = String(req.query.type || "all").toLowerCase();
  const rows = type === "demo" ? all.filter((l) => l.result === "demo")
    : type === "failed" ? all.filter((l) => l.result !== "demo")
    : all;
  const cap = limitOf(req, 200, 2000);
  const logs = rows.slice(0, cap).map(({ password, ...rest }) => rest);
  res.json({ success: true, type, counts, matched: rows.length, returned: logs.length, logs });
});

// ── Server Logs ──────────────────────────────────────────────────────────────
// One IST day (default today). Filters: src (strategy/file tag, same key the
// Server Logs strategy filter uses), level, q (case-insensitive text). Returns
// the last `limit` matches unless `from` (index into the matches) is given.
const normSrc = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
const SCAN_CHUNK = 5000;

router.get("/server-logs", async (req, res) => {
  const today = logArchive.istDateString();
  const dateQ = optDate(req, res, "date"); if (dateQ === false) return;
  const date = dateQ || today;
  const src = req.query.src ? normSrc(req.query.src) : null;
  const level = req.query.level ? String(req.query.level).toLowerCase() : null;
  const q = req.query.q ? String(req.query.q).toLowerCase() : null;
  const cap = limitOf(req, 200, 2000);
  const fromRaw = req.query.from;
  const fromIdx = fromRaw == null || fromRaw === "" ? null : Math.max(0, parseInt(fromRaw, 10) || 0);

  const days = logArchive.listDates();
  const sources = new Map();
  let matched = 0;
  // Keep only the window we will return, never the whole day in memory.
  let window = [];
  const take = (e) => {
    const k = normSrc(e && e.src) || "untagged";
    sources.set(k, (sources.get(k) || 0) + 1);
    if (src && k !== src) return;
    if (level && String(e.level || "").toLowerCase() !== level) return;
    if (q && !String(e.msg || "").toLowerCase().includes(q)) return;
    const i = matched++;
    if (fromIdx == null) {
      window.push(e);
      // Trim in batches — shift() per line is O(n) and a day can be 1M lines.
      if (window.length > cap * 2 + 100) window = window.slice(-cap);
    } else if (i >= fromIdx && i < fromIdx + cap) {
      window.push(e);
    }
  };

  try {
    if (logArchive.ENABLED) {
      if (date === today) logArchive.flush(true);
      for (let from = 0; ; from += SCAN_CHUNK) {
        const { total, logs } = await logArchive.readDayPage(date, from, SCAN_CHUNK);
        for (const e of logs) take(e);
        if (!logs.length || from + SCAN_CHUNK >= total) break;
      }
    } else if (date === today) {
      for (const e of logStore) take(e); // archive off: only this process's ring
    }
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
  if (fromIdx == null) window = cap ? window.slice(-cap) : [];

  res.json({
    success: true,
    date,
    archiveEnabled: logArchive.ENABLED,
    retainDays: logArchive.RETAIN_DAYS,
    days,
    sources: [...sources.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count),
    filter: { src, level, q },
    matched,
    from: fromIdx == null ? Math.max(0, matched - window.length) : fromIdx,
    returned: window.length,
    logs: window,
  });
});

// ── Post-exit tracking ───────────────────────────────────────────────────────
// One line per closed trade: best/worst spot move after the exit and the spot
// at +5/+15/+30/+60 min, written at 15:30 IST by utils/postExitTracker.
router.get("/post-exit", (req, res) => {
  const want = req.query.mode ? String(req.query.mode).toLowerCase() : null;
  const from = optDate(req, res, "from"); if (from === false) return;
  const to = optDate(req, res, "to"); if (to === false) return;
  const cap = limitOf(req, 200, 2000);
  let names = [];
  try { names = fs.readdirSync(postExitTracker.OUT_DIR); } catch (_) { /* none yet */ }
  const dates = names
    .map((n) => /^(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(n))
    .filter(Boolean)
    .map((m) => m[1])
    .sort((a, b) => b.localeCompare(a));

  const rows = [];
  let matched = 0;
  for (const date of dates.filter((d) => inRange(d, from, to))) {
    let text = "";
    try { text = fs.readFileSync(path.join(postExitTracker.OUT_DIR, `${date}.jsonl`), "utf-8"); } catch (_) { continue; }
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let r;
      try { r = JSON.parse(line); } catch (_) { continue; }
      if (want && String(r.mode || "").toLowerCase() !== want) continue;
      matched++;
      if (rows.length < cap) rows.push(r);
    }
  }
  res.json({ success: true, mode: want, from, to, dates, matched, returned: rows.length, records: rows });
});

module.exports = router;

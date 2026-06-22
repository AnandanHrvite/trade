/**
 * aiExport.js — turn raw trade JSONL into an "AI-friendly" Markdown report.
 *
 * Why this exists: every download in the app ships raw JSONL — one JSON object
 * per line, cryptic field names, settings_snapshot lines interleaved, and (in
 * "Download Everything") several strategies' schemas mixed together. That is fine
 * for machines but poor for pasting into an AI for analysis: there is no summary,
 * no field legend, and no separation of config from trades.
 *
 * This module is the single source of truth for the AI format. Server download
 * endpoints (Trade Logs, paper pages) feed it parsed records; it returns one
 * self-describing Markdown document:
 *
 *   # title
 *   ## Summary           — per-mode + total: trades, W/L, win%, net P&L, avg win/loss
 *   ## Field legend      — plain-English meaning of every field actually present
 *   ## Settings          — condensed snapshot(s) of the config that produced the trades
 *   ## Trades            — per-mode tables, columns = the keys actually present
 *
 * Consolidation / Live Consolidation render the same shape client-side from their
 * already-normalised trade objects (they filter in the browser); keep the two in
 * sync if you change the structure here.
 */

// Plain-English meaning for the fields we know about. Only emitted for keys that
// actually appear in the data, so the legend never lists irrelevant fields.
const FIELD_LEGEND = {
  mode: "Strategy that produced the trade (swing / scalp / pa / orb).",
  strategy: "Strategy label (same as mode, kept for compatibility).",
  date: "Trade date, IST (YYYY-MM-DD).",
  side: "CE = call (bullish bet) · PE = put (bearish bet).",
  symbol: "Option contract traded.",
  qty: "Quantity in units (lot size × lots).",
  entryPrice: "Option premium paid at entry (₹).",
  exitPrice: "Option premium received at exit (₹).",
  spotAtEntry: "NIFTY spot index level when the trade was entered.",
  spotAtExit: "NIFTY spot index level when the trade was exited.",
  optionEntryLtp: "Option last-traded price at entry (₹).",
  optionExitLtp: "Option last-traded price at exit (₹).",
  optionStrike: "Strike price of the option.",
  optionType: "CE (call) or PE (put).",
  optionExpiry: "Option expiry date.",
  entryTime: "Entry timestamp, IST.",
  exitTime: "Exit timestamp, IST.",
  pnl: "Realised profit/loss for the trade in ₹ (negative = loss).",
  pnlMode: '"option" = P&L from option LTP move · "spot proxy" = P&L estimated from the spot move when option data was unavailable.',
  entryReason: "Signal/condition that triggered entry.",
  exitReason: "What closed the trade (target, stop-loss, trail, time-stop, BB-reentry, etc.).",
  instrument: "Instrument type (e.g. NIFTY_OPTIONS).",
  loggedAt: "When the record was written to the log (UTC ISO).",
  id: "Internal trade id.",
};

// Preferred column order for the per-mode trade tables. Any extra scalar keys
// present in the data are appended after these, so nothing is silently dropped.
const PREFERRED_ORDER = [
  "date", "entryTime", "exitTime", "side", "symbol", "optionStrike", "optionType",
  "qty", "entryPrice", "exitPrice", "optionEntryLtp", "optionExitLtp",
  "spotAtEntry", "spotAtExit", "pnl", "pnlMode", "entryReason", "exitReason",
];

// Keys that add noise to the per-trade table without aiding analysis.
const TABLE_DENYLIST = new Set(["mode", "strategy", "loggedAt", "type", "capturedAt", "reason", "settings"]);

function isSnapshot(rec) {
  return rec && typeof rec === "object" && rec.type === "settings_snapshot";
}

/** Split a flat list of parsed JSONL objects into trades and settings snapshots. */
function splitRecords(objs) {
  const trades = [];
  const snapshots = [];
  for (const o of objs || []) {
    if (!o || typeof o !== "object") continue;
    if (isSnapshot(o)) snapshots.push(o);
    else trades.push(o);
  }
  return { trades, snapshots };
}

/** Parse JSONL text (one JSON object per line) into objects, skipping bad lines. */
function parseJsonl(text) {
  const out = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch (_) { /* skip malformed line */ }
  }
  return out;
}

function num(v) {
  return typeof v === "number" && isFinite(v) ? v : null;
}

function fmtNum(v) {
  // Trim noisy float tails but keep integers clean.
  if (!isFinite(v)) return String(v);
  return Number.isInteger(v) ? String(v) : (Math.round(v * 100) / 100).toString();
}

function fmtPnl(v) {
  const n = num(v);
  if (n === null) return "—";
  return (n >= 0 ? "+" : "") + fmtNum(n);
}

// Render a single cell value for a Markdown table: keep it on one line, escape pipes.
function cell(v) {
  if (v == null) return "";
  let s;
  if (typeof v === "object") s = JSON.stringify(v);
  else if (typeof v === "number") s = fmtNum(v);
  else s = String(v);
  s = s.replace(/\r?\n/g, " ").replace(/\|/g, "\\|");
  if (s.length > 90) s = s.slice(0, 89) + "…";
  return s;
}

function modeOf(t) {
  return String(t.mode || t.strategy || "unknown");
}

/** Per-mode + total performance stats. */
function summarise(trades) {
  const byMode = new Map();
  for (const t of trades) {
    const m = modeOf(t);
    if (!byMode.has(m)) byMode.set(m, []);
    byMode.get(m).push(t);
  }
  const row = (label, list) => {
    const wins = list.filter(t => num(t.pnl) > 0);
    const losses = list.filter(t => num(t.pnl) < 0);
    const net = list.reduce((a, t) => a + (num(t.pnl) || 0), 0);
    const avgWin = wins.length ? wins.reduce((a, t) => a + t.pnl, 0) / wins.length : 0;
    const avgLoss = losses.length ? losses.reduce((a, t) => a + t.pnl, 0) / losses.length : 0;
    const decided = wins.length + losses.length;
    const winPct = decided ? Math.round((wins.length / decided) * 100) : 0;
    return { label, n: list.length, w: wins.length, l: losses.length, winPct, net, avgWin, avgLoss };
  };
  const rows = Array.from(byMode.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([m, list]) => row(m, list));
  const total = row("TOTAL", trades);
  return { rows, total, modes: rows.map(r => r.label) };
}

/** Build the per-mode trade tables (columns = the keys actually present). */
function tradesSection(trades) {
  const byMode = new Map();
  for (const t of trades) {
    const m = modeOf(t);
    if (!byMode.has(m)) byMode.set(m, []);
    byMode.get(m).push(t);
  }
  const parts = [];
  for (const [m, list] of Array.from(byMode.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
    // Columns = preferred order ∩ present, then any other present scalar keys.
    const present = new Set();
    for (const t of list) for (const k of Object.keys(t)) if (!TABLE_DENYLIST.has(k)) present.add(k);
    const cols = PREFERRED_ORDER.filter(c => present.has(c));
    for (const k of present) if (!cols.includes(k)) cols.push(k);
    const net = list.reduce((a, t) => a + (num(t.pnl) || 0), 0);
    parts.push(`### ${m} — ${list.length} trade${list.length === 1 ? "" : "s"}, net ${fmtPnl(net)}`);
    if (!cols.length) { parts.push("_(no fields)_"); continue; }
    parts.push("| " + cols.join(" | ") + " |");
    parts.push("| " + cols.map(() => "---").join(" | ") + " |");
    for (const t of list) {
      parts.push("| " + cols.map(c => (c === "pnl" ? fmtPnl(t[c]) : cell(t[c]))).join(" | ") + " |");
    }
    parts.push("");
  }
  return parts.join("\n");
}

/** Field legend, restricted to fields that actually appear. */
function legendSection(trades) {
  const present = new Set();
  for (const t of trades) for (const k of Object.keys(t)) present.add(k);
  const known = Object.keys(FIELD_LEGEND).filter(k => present.has(k));
  const lines = known.map(k => `- \`${k}\` — ${FIELD_LEGEND[k]}`);
  const unknown = Array.from(present).filter(k => !FIELD_LEGEND[k] && !TABLE_DENYLIST.has(k)).sort();
  if (unknown.length) lines.push(`- _Other fields (strategy-specific):_ ${unknown.map(k => "`" + k + "`").join(", ")}`);
  return lines.join("\n");
}

/** Condensed view of the settings snapshot(s) that produced the trades. */
function settingsSection(snapshots) {
  if (!snapshots.length) return "";
  const lines = [];
  for (const s of snapshots) {
    const when = s.capturedAt || "";
    const why = s.reason ? ` (${s.reason})` : "";
    const cfg = s.settings && typeof s.settings === "object"
      ? Object.entries(s.settings).map(([k, v]) => `${k}=${v}`).join(", ")
      : "";
    lines.push(`- **${modeOf(s)}** @ ${when}${why}: ${cfg || "—"}`);
  }
  return lines.join("\n");
}

/**
 * Build the full Markdown report.
 * @param {object[]} records  parsed JSONL objects (trades + settings snapshots, any mode)
 * @param {object}   meta     { title, source, range }
 * @returns {string} Markdown
 */
function buildMarkdown(records, meta = {}) {
  const { trades, snapshots } = splitRecords(records);
  const title = meta.title || "Trade export";
  const stats = summarise(trades);

  const out = [];
  out.push(`# ${title} — AI-friendly export`);
  const meta1 = [];
  if (meta.source) meta1.push(`Source: ${meta.source}`);
  if (meta.range) meta1.push(`Range: ${meta.range}`);
  meta1.push(`${trades.length} trade${trades.length === 1 ? "" : "s"}`);
  if (stats.modes.length) meta1.push(`modes: ${stats.modes.join(", ")}`);
  out.push(`> ${meta1.join(" · ")}`);
  out.push(`>`);
  out.push(`> Structured for AI analysis: summary stats, a field legend, the config that produced the trades, then the trades themselves. P&L is in ₹ unless noted.`);
  out.push("");

  if (!trades.length) {
    out.push("_No trades in this export._");
    if (snapshots.length) {
      out.push("");
      out.push("## Settings (config snapshot)");
      out.push(settingsSection(snapshots));
    }
    return out.join("\n") + "\n";
  }

  out.push("## Summary");
  out.push("| Mode | Trades | Wins | Losses | Win % | Net P&L | Avg win | Avg loss |");
  out.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
  const sumRow = (r) => `| ${r.label} | ${r.n} | ${r.w} | ${r.l} | ${r.winPct}% | ${fmtPnl(r.net)} | ${r.avgWin ? fmtPnl(r.avgWin) : "—"} | ${r.avgLoss ? fmtPnl(r.avgLoss) : "—"} |`;
  for (const r of stats.rows) out.push(sumRow(r));
  if (stats.rows.length > 1) out.push(sumRow({ ...stats.total, label: "**TOTAL**" }));
  out.push("");

  out.push("## Field legend");
  out.push(legendSection(trades));
  out.push("");

  const settings = settingsSection(snapshots);
  if (settings) {
    out.push("## Settings (config that produced these trades)");
    out.push(settings);
    out.push("");
  }

  out.push("## Trades");
  out.push(tradesSection(trades));

  return out.join("\n") + "\n";
}

/** Convenience: JSONL text → Markdown. */
function jsonlToMarkdown(text, meta = {}) {
  return buildMarkdown(parseJsonl(text), meta);
}

// ── Skip logs ───────────────────────────────────────────────────────────────
// Skips are rejected signals (a gate blocked entry), so they carry no P&L. The
// useful summary is "how many, broken down by which gate" — not win/loss.

const SKIP_LEGEND = {
  mode: "Strategy that produced the rejected signal (swing / scalp / pa / orb).",
  gate: "Which gate blocked entry (e.g. vix, spread, strategy, oi).",
  reason: "Plain-English reason the signal was rejected.",
  side: "Intended direction — CE (call) / PE (put).",
  ts: "When the signal was rejected (UTC ISO).",
  istDate: "Rejection date, IST.",
  spot: "NIFTY spot at the moment of rejection.",
  rsi: "RSI value at rejection.",
  adx: "ADX value at rejection.",
  audit: "Extra gate detail / supporting numbers.",
};
const SKIP_ORDER = ["istDate", "ts", "side", "gate", "reason", "spot", "rsi", "adx", "audit"];
const SKIP_DENY = new Set(["mode", "type"]);

// "vix (12), spread (5), strategy (3)" — counts per gate, busiest first.
function gateBreakdown(skips) {
  const counts = new Map();
  for (const s of skips) {
    const g = String(s.gate || "—");
    counts.set(g, (counts.get(g) || 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([g, n]) => `${g} (${n})`)
    .join(", ") || "—";
}

/**
 * Build a Markdown report for skip (rejected-signal) logs.
 * @param {object[]} records parsed skip JSONL objects (any mode)
 * @param {object}   meta    { title, source, range }
 */
function buildSkipMarkdown(records, meta = {}) {
  const skips = (records || []).filter(r => r && typeof r === "object" && r.type !== "settings_snapshot");
  const title = meta.title || "Skip log";

  const byMode = new Map();
  for (const s of skips) {
    const m = modeOf(s);
    if (!byMode.has(m)) byMode.set(m, []);
    byMode.get(m).push(s);
  }
  const modes = Array.from(byMode.keys()).sort();

  const out = [];
  out.push(`# ${title} — AI-friendly export`);
  const m1 = [];
  if (meta.source) m1.push(`Source: ${meta.source}`);
  if (meta.range) m1.push(`Range: ${meta.range}`);
  m1.push(`${skips.length} skip${skips.length === 1 ? "" : "s"}`);
  if (modes.length) m1.push(`modes: ${modes.join(", ")}`);
  out.push(`> ${m1.join(" · ")}`);
  out.push(`>`);
  out.push(`> Skips are signals a gate blocked, so they never became trades. Structured for AI analysis: per-gate counts, a field legend, then the rejections — use it to see *why* trades didn't happen. Only strategy/VIX/spread/OI gates are logged (operational gates like cooldown and market-hours are not).`);
  out.push("");

  if (!skips.length) {
    out.push("_No skips in this export._");
    return out.join("\n") + "\n";
  }

  out.push("## Summary");
  out.push("| Mode | Skips | By gate |");
  out.push("| --- | ---: | --- |");
  for (const m of modes) out.push(`| ${m} | ${byMode.get(m).length} | ${gateBreakdown(byMode.get(m))} |`);
  if (modes.length > 1) out.push(`| **TOTAL** | ${skips.length} | ${gateBreakdown(skips)} |`);
  out.push("");

  const present = new Set();
  for (const s of skips) for (const k of Object.keys(s)) present.add(k);
  out.push("## Field legend");
  for (const k of Object.keys(SKIP_LEGEND)) if (present.has(k)) out.push(`- \`${k}\` — ${SKIP_LEGEND[k]}`);
  const unknown = Array.from(present).filter(k => !SKIP_LEGEND[k] && !SKIP_DENY.has(k)).sort();
  if (unknown.length) out.push(`- _Other fields (strategy-specific):_ ${unknown.map(k => "`" + k + "`").join(", ")}`);
  out.push("");

  out.push("## Skips");
  for (const m of modes) {
    const list = byMode.get(m);
    const keys = new Set();
    for (const s of list) for (const k of Object.keys(s)) if (!SKIP_DENY.has(k)) keys.add(k);
    const cols = SKIP_ORDER.filter(c => keys.has(c));
    for (const k of keys) if (!cols.includes(k)) cols.push(k);
    out.push(`### ${m} — ${list.length} skip${list.length === 1 ? "" : "s"}`);
    if (!cols.length) { out.push("_(no fields)_"); continue; }
    out.push("| " + cols.join(" | ") + " |");
    out.push("| " + cols.map(() => "---").join(" | ") + " |");
    for (const s of list) out.push("| " + cols.map(c => cell(s[c])).join(" | ") + " |");
    out.push("");
  }

  return out.join("\n") + "\n";
}

/** Convenience: skip JSONL text → Markdown. */
function jsonlToSkipMarkdown(text, meta = {}) {
  return buildSkipMarkdown(parseJsonl(text), meta);
}

module.exports = {
  buildMarkdown,
  jsonlToMarkdown,
  buildSkipMarkdown,
  jsonlToSkipMarkdown,
  parseJsonl,
  splitRecords,
  FIELD_LEGEND,
};

/**
 * dailyExport.js — one CSV + one JSON summary per trading day, for analysis
 * outside the app:
 *
 *   ~/trading-data/exports/trades_YYYY-MM-DD.csv          one row per trade
 *   ~/trading-data/exports/daily_summary_YYYY-MM-DD.json  the day's numbers
 *
 * Source: the consolidated page's own trade set (routes/consolidation —
 * enabled strategies + retired copy books, every market), each trade's journal
 * (utils/tradeJournal) when it has one, the post-exit join the page already
 * does, and the day's skip logs. Read-only over all of them: no existing log
 * file or folder is moved, renamed or rewritten.
 *
 * When: automatically once per trading day at or after 16:30 IST (checked
 * every 5 min; the day it last ran is kept in exports/_state.json so a restart
 * does not run it twice), and on demand from /consolidation. Never during
 * 09:00–15:30 IST on a weekday — the on-demand call refuses then too. NOTE:
 * MCX trades after 16:30 are not in the automatic file; an on-demand export
 * after the MCX close picks them up.
 *
 * Writes are atomic (tmp file → rename), so a reader never sees a half file.
 * Nothing secret is written: trade fields, reasons and numbers only — no
 * settings, tokens or env. exports/ is protected from the disk auto-cleanup
 * (utils/diskRetention).
 *
 * Pure observer: nothing reads these files back into a decision.
 */

"use strict";

const fs   = require("fs");
const path = require("path");
const os   = require("os");

const EXPORT_DIR   = path.join(os.homedir(), "trading-data", "exports");
const STATE_FILE   = path.join(EXPORT_DIR, "_state.json");
const AUTO_MIN_IST = 16 * 60 + 30;
const MKT_OPEN_MIN = 9 * 60;
const MKT_CLOSE_MIN = 15 * 60 + 30;
const CHECK_MS     = 5 * 60 * 1000;

function istParts(ms) {
  const d = new Date(ms + 19800000);
  const p = (n) => (n < 10 ? "0" : "") + n;
  return {
    date: `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`,
    min: d.getUTCHours() * 60 + d.getUTCMinutes(),
    dow: d.getUTCDay(),
  };
}

/** True during 09:00–15:30 IST on a weekday — no export may run then. */
function inMarketHours(nowMs) {
  const p = istParts(nowMs != null ? nowMs : Date.now());
  return p.dow >= 1 && p.dow <= 5 && p.min >= MKT_OPEN_MIN && p.min < MKT_CLOSE_MIN;
}

const _n = (v) => (v != null && v !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
const r2 = (n) => (n == null ? null : Math.round(n * 100) / 100);
const r1 = (n) => (n == null ? null : Math.round(n * 10) / 10);
const sum = (a) => a.reduce((s, x) => s + x, 0);
const avg = (a) => (a.length ? sum(a) / a.length : null);

// ── CSV ──────────────────────────────────────────────────────────────────────
const CSV_COLUMNS = [
  "date", "market", "strategy", "mode", "side", "symbol", "strike", "qty",
  "entry_time", "entry_price", "exit_time", "exit_price", "option_entry_ltp", "option_exit_ltp",
  "entry_reason", "exit_reason",
  "peak_pts", "peak_rs", "peak_time", "drawdown_pts", "drawdown_rs", "drawdown_time",
  "giveback_pts", "giveback_rs", "giveback_pct_of_peak", "slippage_pts", "slippage_rs",
  "hold_min", "gross", "charges", "net", "post_exit_best_pts", "post_exit_best_time", "trade_id",
];

function csvCell(v) {
  if (v == null) return "";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  let s = String(v);
  // A text cell a spreadsheet would run as a formula is prefixed with a quote.
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** One export row: the consolidated row + its journal (or the route's own mfe/mae). */
function rowFor(t, j, extra) {
  const peak = j && j.peak, worst = j && j.worst, ex = j && j.exit;
  const mfe = peak ? peak.pts : (extra && extra.mfe != null ? extra.mfe : null);
  const mae = worst ? worst.pts : (extra && extra.mae != null ? extra.mae : null);
  return {
    date: t.date, market: t.market, strategy: t.strategyId || t.mode, mode: t.mode,
    side: t.side || null, symbol: t.symbol || null, strike: t.optionStrike != null ? t.optionStrike : null,
    qty: _n(t.qty),
    entry_time: t.entryTime || null, entry_price: _n(t.entryPrice),
    exit_time: t.exitTime || null, exit_price: _n(t.exitPrice),
    option_entry_ltp: _n(t.optionEntryLtp), option_exit_ltp: _n(t.optionExitLtp),
    entry_reason: t.entryReason || null, exit_reason: t.exitReason || null,
    peak_pts: _n(mfe), peak_rs: j && j.peakRs ? _n(j.peakRs.rs) : null, peak_time: peak ? peak.ist : null,
    drawdown_pts: _n(mae), drawdown_rs: j && j.worstRs ? _n(j.worstRs.rs) : null, drawdown_time: worst ? worst.ist : null,
    giveback_pts: ex ? _n(ex.givebackPts) : null, giveback_rs: ex ? _n(ex.givebackRs) : null,
    giveback_pct_of_peak: ex ? _n(ex.givebackPctOfPeak) : null,
    slippage_pts: ex ? _n(ex.slippagePts) : null, slippage_rs: ex ? _n(ex.slippageRs) : null,
    hold_min: ex ? _n(ex.holdMin) : null,
    gross: _n(t.gross), charges: _n(t.charges), net: _n(t.pnl),
    post_exit_best_pts: t.postExit ? _n(t.postExit.bestPts) : null,
    post_exit_best_time: t.postExit ? (t.postExit.bestTime || null) : null,
    trade_id: (j && j.id) || t.journalId || null,
  };
}

function toCsv(rows) {
  const lines = [CSV_COLUMNS.join(",")];
  for (const r of rows) lines.push(CSV_COLUMNS.map((c) => csvCell(r[c])).join(","));
  return lines.join("\r\n") + "\r\n";
}

// ── Summary ──────────────────────────────────────────────────────────────────
function _orderKey(t, j) {
  if (j && j.exit && Number.isFinite(j.exit.ms)) return j.exit.ms;
  const m = String(t.exitTime || "").match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  return m ? Date.parse(`${t.date}T00:00:00+05:30`) + ((+m[1]) * 3600 + (+m[2]) * 60 + (+(m[3] || 0))) * 1000 : Infinity;
}

/**
 * The day's numbers. `rows` = export rows (rowFor), in exit order; `skips` =
 * { mode: count } of the day's skipped signals.
 */
function summarise(date, rows, skips) {
  const net = rows.map((r) => r.net || 0);
  const wins = net.filter((x) => x > 0), losses = net.filter((x) => x < 0);
  const grossProfit = sum(wins), grossLoss = sum(losses);
  let eq = 0, hi = 0, maxDd = 0;
  for (const x of net) { eq += x; if (eq > hi) hi = eq; if (hi - eq > maxDd) maxDd = hi - eq; }
  const charges = rows.map((r) => r.charges).filter((x) => x != null);
  const gross = rows.map((r) => (r.gross != null ? r.gross : r.net)).filter((x) => x != null);
  const mfe = rows.map((r) => r.peak_pts).filter((x) => x != null);
  const mae = rows.map((r) => r.drawdown_pts).filter((x) => x != null);
  const gb = rows.map((r) => r.giveback_pts).filter((x) => x != null);
  const slip = rows.map((r) => r.slippage_pts).filter((x) => x != null);
  const group = (key) => {
    const o = {};
    for (const r of rows) {
      const k = r[key] || "?";
      if (!o[k]) o[k] = { trades: 0, wins: 0, net: 0 };
      o[k].trades++; if ((r.net || 0) > 0) o[k].wins++; o[k].net = r2(o[k].net + (r.net || 0));
    }
    return o;
  };
  const skipByMode = {};
  let skipTotal = 0;
  for (const k of Object.keys(skips || {}).sort()) { if (skips[k] > 0) { skipByMode[k] = skips[k]; skipTotal += skips[k]; } }
  return {
    type: "daily_summary", date, generatedAt: new Date().toISOString(),
    trades: rows.length, wins: wins.length, losses: losses.length, flat: rows.length - wins.length - losses.length,
    winRatePct: rows.length ? r1(wins.length / rows.length * 100) : null,
    grossProfit: r2(grossProfit), grossLoss: r2(grossLoss),
    gross: gross.length ? r2(sum(gross)) : null,
    charges: charges.length ? r2(sum(charges)) : null,
    net: r2(sum(net)),
    profitFactor: losses.length ? r2(grossProfit / Math.abs(grossLoss)) : null,
    profitFactorNote: losses.length ? null : (wins.length ? "no losing trades" : "no trades with P&L"),
    avgWin: wins.length ? r2(avg(wins)) : null,
    avgLoss: losses.length ? r2(avg(losses)) : null,
    maxDrawdown: r2(maxDd),
    mfe: { trades: mfe.length, avgPts: r2(avg(mfe)), maxPts: mfe.length ? r2(Math.max.apply(null, mfe)) : null },
    mae: { trades: mae.length, avgPts: r2(avg(mae)), worstPts: mae.length ? r2(Math.min.apply(null, mae)) : null },
    giveback: { trades: gb.length, avgPts: r2(avg(gb)) },
    slippage: { trades: slip.length, avgPts: r2(avg(slip)) },
    journaled: rows.filter((r) => r.trade_id).length,
    byStrategy: group("strategy"),
    byMarket: group("market"),
    skippedSignals: { total: skipTotal, byMode: skipByMode },
  };
}

/** Pure: consolidated rows of ONE day + journals + skips → { rows, csv, summary }. */
function buildExport(date, dayRows, journals, skips, extraOf) {
  const items = dayRows.map((t) => {
    const j = (t.journalId && journals && journals.get(String(t.journalId))) || null;
    return { t, j, key: _orderKey(t, j) };
  });
  items.sort((a, b) => a.key - b.key);
  const rows = items.map((x) => rowFor(x.t, x.j, extraOf ? extraOf(x.t) : null));
  return { rows, csv: toCsv(rows), summary: summarise(date, rows, skips) };
}

// ── I/O ──────────────────────────────────────────────────────────────────────
function writeAtomicSync(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

function skipCounts(date) {
  const out = {};
  let sl;
  try { sl = require("./skipLogger"); } catch (_) { return out; }
  for (const mode of Object.keys(sl.FILE_PREFIX_BY_MODE || {})) {
    try { const n = sl.readDailySkips(mode, date).length; if (n) out[mode] = n; } catch (_) {}
  }
  return out;
}

/**
 * Write both files for `date` (IST "YYYY-MM-DD", default today). Refuses during
 * weekday market hours. Returns { ok, csvPath, summaryPath, trades } or { ok:false, error }.
 */
function writeDay(date, opts) {
  const o = opts || {};
  const nowMs = o.nowMs != null ? o.nowMs : Date.now();
  if (inMarketHours(nowMs)) return { ok: false, error: "Exports never run 09:00–15:30 IST on a weekday. Try after the close." };
  const day = date || istParts(nowMs).date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return { ok: false, error: `Bad date "${day}" (want YYYY-MM-DD)` };
  try {
    const consolidation = o.consolidation || require("../routes/consolidation");
    const all = consolidation.loadConsolidatedTrades().trades;
    const dayRows = all.filter((t) => t.date === day);
    const journals = consolidation.journalsFor(dayRows.map((t) => t.journalId).filter(Boolean));
    const out = buildExport(day, dayRows, journals, o.skips || skipCounts(day), consolidation.extraOf);
    const dir = o.dir || EXPORT_DIR;
    const csvPath = path.join(dir, `trades_${day}.csv`);
    const summaryPath = path.join(dir, `daily_summary_${day}.json`);
    writeAtomicSync(csvPath, out.csv);
    writeAtomicSync(summaryPath, JSON.stringify(out.summary, null, 2) + "\n");
    return { ok: true, date: day, csvPath, summaryPath, trades: out.rows.length, summary: out.summary };
  } catch (err) {
    return { ok: false, error: `export failed: ${err.message}` };
  }
}

function _readState(file) {
  try { return JSON.parse(fs.readFileSync(file || STATE_FILE, "utf-8")) || {}; } catch (_) { return {}; }
}

/**
 * The scheduled check: once per trading day, at or after 16:30 IST. `opts`
 * (tests) may carry isNonTradingDay, stateFile and writeDay's own opts.
 */
async function check(nowMs, opts) {
  const o = opts || {};
  const now = nowMs != null ? nowMs : Date.now();
  const p = istParts(now);
  const stateFile = o.stateFile || (o.dir ? path.join(o.dir, "_state.json") : STATE_FILE);
  if (p.min < AUTO_MIN_IST || inMarketHours(now)) return { ran: false, why: "before 16:30 IST" };
  if (_readState(stateFile).lastAutoDate === p.date) return { ran: false, why: "already ran today" };
  try {
    const isNonTradingDay = o.isNonTradingDay || require("./nseHolidays").isNonTradingDay;
    if (await isNonTradingDay(new Date(`${p.date}T12:00:00`))) return { ran: false, why: "not a trading day" };
  } catch (_) {}
  const res = writeDay(p.date, { ...o, nowMs: now });
  if (res.ok) {
    try { writeAtomicSync(stateFile, JSON.stringify({ lastAutoDate: p.date, at: new Date(now).toISOString() })); } catch (_) {}
    console.log(`🗂️ [dailyExport] wrote ${path.basename(res.csvPath)} + ${path.basename(res.summaryPath)} (${res.trades} trade(s))`);
  } else {
    console.warn(`[dailyExport] ${res.error}`);
  }
  return { ran: res.ok, result: res };
}

let _timer = null;
function start() {
  if (_timer) return;
  const run = () => { check().catch((e) => console.warn(`[dailyExport] check failed: ${e.message}`)); };
  _timer = setInterval(run, CHECK_MS);
  if (_timer.unref) _timer.unref();
  run();
}
function stop() { if (_timer) { clearInterval(_timer); _timer = null; } }

module.exports = {
  writeDay, check, start, stop, buildExport, summarise, toCsv, rowFor, csvCell, inMarketHours,
  EXPORT_DIR, STATE_FILE, CSV_COLUMNS, AUTO_MIN_IST,
};

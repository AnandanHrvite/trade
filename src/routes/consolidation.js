/**
 * CONSOLIDATION — /consolidation
 * ─────────────────────────────────────────────────────────────────────────────
 * Aggregated, cross-strategy, cross-market PAPER trade history + analytics.
 * Reads every enabled strategy's paper-trade JSON book plus the retired copy
 * books still on disk (BN_* / FUT_* / CMX_* / SAIL_PIVOT_EMA_ST), flattens every
 * trade with its mode + date, and renders a single unified view with:
 *   • Filters: market, strategy, date preset / custom range, side, win/loss,
 *     exit reason, expiry day, search — combined, and kept in the URL query
 *   • Totals for the filtered set + per-market / per-strategy breakdowns
 *   • Daily / Monthly / Yearly P&L roll-ups, post-exit move per trade
 *   • Per-trade copy + bulk copy (daily / weekly / monthly)
 * The filter + totals maths lives in utils/consolidationCore.js and runs here
 * verbatim in the browser — see tests/consolidation.regression.js.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const express = require("express");
const router = express.Router();
const fs = require("fs");
const path = require("path");
const { buildSidebar, sidebarCSS, faviconLink, modalCSS, modalJS, toastJS, aiExportJS } = require("../utils/sharedNav");
const { resolveTheme } = require("../utils/theme");
const { istDayFromAny } = require("../utils/tradeUtils");
const CC = require("../utils/consolidationCore");

const _HOME = require("os").homedir();
const DATA_DIR = path.join(_HOME, "trading-data");

const SOURCES = [
  { mode: "EMA_RSI_ST",    file: path.join(DATA_DIR, "ema_rsi_st_paper_trades.json"),          label: "EMA_RSI_ST", color: "#3b82f6" },
  // NIFTY FUTURES twins (CE = LONG future, PE = SHORT) — each its own trades file,
  // never folded into the options strategy it mirrors. One amber futures accent.
  // EMA_RSI_ST_V2 — a separate strategy from V1 with its own trades file, never
  // folded into EMA_RSI_ST's.
  { mode: "EMA_RSI_ST_V2", file: path.join(DATA_DIR, "ema_rsi_st_v2_paper_trades.json"), label: "EMA_RSI_ST_V2", color: "#38bdf8" },
  // The same engine on NIFTY BANK — its own trades file, never merged with the
  // NIFTY one: same rules, different underlying and different settings.
  // ST_RSI_PIV_BB — its own trades file.
  { mode: "ST_RSI_PIV_BB", file: path.join(DATA_DIR, "st_rsi_piv_bb_paper_trades.json"), label: "ST_RSI_PIV_BB", color: "#a3e635" },
  // SAIL_VWAP_ST (SAIL stock options) — its own trades file.
  { mode: "SAIL_VWAP_ST", file: path.join(DATA_DIR, "sail_vwap_st_paper_trades.json"), label: "VWAP_ST", color: "#fda4af" },
  // PIVOT_EMA_ST — its own trades file (default ON).
  { mode: "PIVOT_EMA_ST", file: path.join(DATA_DIR, "pivot_ema_st_paper_trades.json"), label: "PIVOT_EMA_ST", color: "#38bdf8" },
  // GAP_RUNAWAY (NIFTY options) + its stock scanner (intraday shares) — each its own trades file (default ON).
  { mode: "GAP_RUNAWAY", file: path.join(DATA_DIR, "gap_runaway_paper_trades.json"), label: "GAP_runAway__Kirubakaran", color: "#a78bfa" },
  { mode: "GAP_RUNAWAY_STK", file: path.join(DATA_DIR, "gap_runaway_stk_paper_trades.json"), label: "GAP_runAway Stocks", color: "#c084fc" },
  { mode: "BB_RSI",    file: path.join(DATA_DIR, "bb_rsi_paper_trades.json"),    label: "BB_RSI", color: "#f59e0b" },
  { mode: "PA",       file: path.join(DATA_DIR, "pa_paper_trades.json"),       label: "Price Action", color: "#a855f7" },
  { mode: "ORB",      file: path.join(DATA_DIR, "orb_paper_trades.json"),      label: "ORB", color: "#10b981" },
  { mode: "EMA9VWAP", file: path.join(DATA_DIR, "ema9vwap_paper_trades.json"), label: "EMA9+VWAP", color: "#06b6d4" },
  { mode: "TREND_PB", file: path.join(DATA_DIR, "trend_pb_paper_trades.json"), label: "TREND PB", color: "#ec4899" },
  { mode: "TDS",      file: path.join(DATA_DIR, "trend_day_scalp_paper_trades.json"), label: "TREND DAY SCALP", color: "#a855f7" },
  { mode: "HA_SCALP", file: path.join(DATA_DIR, "ha_scalp_paper_trades.json"), label: "HA SCALP", color: "#f97316" },
  { mode: "PREV_ORB_SCALP", file: path.join(DATA_DIR, "prev_orb_scalp_paper_trades.json"), label: "PREV ORB SCALP", color: "#e879f9" },
  { mode: "ITM20_SCALP", file: path.join(DATA_DIR, "itm20_scalp_paper_trades.json"), label: "ITM20 SCALP", color: "#22d3ee" },
  { mode: "RSI_PIVOT_ST", file: path.join(DATA_DIR, "rsi_pivot_st_paper_trades.json"), label: "RSI PIVOT ST", color: "#facc15" },
  // Same rules on NIFTY BANK (monthly options) — its own trades file, never folded into RSI PIVOT ST's.
  { mode: "SIMPLE930", file: path.join(DATA_DIR, "simple930_paper_trades.json"), label: "SIMPLE_9:30", color: "#fb923c" },
  // EarlyBird is cash equity (share counts, real intraday shorts), not options.
  { mode: "EARLYBIRD", file: path.join(DATA_DIR, "early_bird_paper_trades.json"), label: "EarlyBird", color: "#14b8a6" },
  // Running (strategy, market) pairs (config/pairs.js runnable) — each its own
  // trades file under its env prefix (BN_EMA_RSI_ST_V2 …). Generated.
  ...require("../config/pairs").runnable().map(p => ({
    mode: p.envPrefix, file: path.join(DATA_DIR, p.tradesFile),
    label: require("../utils/pairRuntime").forPair(p).title, color: "#2dd4bf",
  })),
];

function safeRead(p) {
  try {
    if (!fs.existsSync(p)) return { capital: 0, totalPnl: 0, sessions: [] };
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch (_) {
    return { capital: 0, totalPnl: 0, sessions: [] };
  }
}

// Cache the flattened+sorted trade list. This is hit by the dashboard P&L chart
// poll every few seconds; re-reading and JSON.parsing all 5 (growing) trade files
// each time is wasteful. Invalidate by a cheap mtime+size signature so a new trade
// is picked up immediately without re-parsing when nothing has changed.
let _allTradesCache = null;
let _allTradesSig   = null;

function _sourcesSig() {
  let sig = "";
  for (const src of SOURCES) {
    try { const st = fs.statSync(src.file); sig += `${src.mode}:${st.mtimeMs}:${st.size}|`; }
    catch (_) { sig += `${src.mode}:0|`; }
  }
  return sig;
}

// Mirror sharedNav's per-strategy gating (default true when the env key is
// unset). Strategies that ship OFF: an unset key means disabled, not enabled.
// Every legacy strategy defaults ON, so the fallback below stays "true".
// Read on every call — Settings saves mutate process.env live.
const _DEFAULT_OFF_MODES = new Set(["EMA_RSI_ST_V2"]);
_DEFAULT_OFF_MODES.add("ST_RSI_PIV_BB"); // ships OFF like V2
_DEFAULT_OFF_MODES.add("SAIL_VWAP_ST"); // ships OFF
for (const p of require("../config/pairs").runnable()) _DEFAULT_OFF_MODES.add(p.envPrefix); // every pair ships OFF
function _modeEnabled(mode) {
  const key = mode + "_MODE_ENABLED";
  const dflt = _DEFAULT_OFF_MODES.has(mode) ? "false" : "true";
  return (process.env[key] || dflt).toLowerCase() === "true";
}
// The SOURCES rows for strategies currently enabled in Settings, in page order.
function enabledSources() { return SOURCES.filter((src) => _modeEnabled(src.mode)); }

// Returns the flattened trades of ENABLED strategies only. A strategy
// switched off in Settings disappears from this page, its /data feed, the
// dashboard curve and the EOD reports alike — its file is left untouched, so
// switching it back on brings the history straight back.
function loadAllTrades() {
  return _loadAllTradesUnfiltered().filter((t) => _modeEnabled(t.mode));
}

function _loadAllTradesUnfiltered() {
  const sig = _sourcesSig();
  if (_allTradesCache && sig === _allTradesSig) return _allTradesCache;
  const out = [];
  for (const src of SOURCES) flattenSessions(src.mode, safeRead(src.file), out);
  // Sort oldest → newest so cumulative curves read left-to-right
  out.sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  _allTradesCache = out;
  _allTradesSig   = sig;
  return out;
}

// One session book ({ sessions: [{ date, trades }] }) → flat rows, appended to `out`.
// Shared by the live sources and the retired copy books below, so a retired
// book's P&L is read exactly the way its own history page read it.
function flattenSessions(mode, data, out) {
  for (const s of (data.sessions || [])) {
    const sessionDate = istDayFromAny(s.date);
    for (const t of (s.trades || [])) out.push(flatRow(mode, sessionDate, s, t));
  }
}

// Per-row extras kept OFF the row itself (so the shared /data rows stay as
// they were): the trade journal's id (utils/tradeJournal) and the route's own
// mfe / mae, for the trade-detail sheet and the daily export. The journal
// itself is read from the book on demand (journalsFor), never held in memory.
const _rowExtra = new WeakMap();
const _numOrNull = (v) => (v != null && v !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
function extraOf(row) { return (row && _rowExtra.get(row)) || null; }

function flatRow(mode, sessionDate, s, t) {
  const row = _flatRow(mode, sessionDate, s, t);
  const j = t && t.journal && typeof t.journal === "object" ? t.journal : null;
  _rowExtra.set(row, {
    journalId: j && j.id ? String(j.id) : null,
    mfe: _numOrNull(t.mfeSpotPts != null ? t.mfeSpotPts : t.mfe),
    mae: _numOrNull(t.maeSpotPts != null ? t.maeSpotPts : t.mae),
  });
  return row;
}

function _flatRow(mode, sessionDate, s, t) {
  return {
          mode:        mode,
          date:        sessionDate,
          strategy:    s.strategy || "",
          // The TRADE knows what it traded; the session-level field is a coarse
          // label and would mark a futures trade as an option after a toggle
          // flip mid-history. Fall back to the session only when the trade is
          // silent (rows written before the instrument was stamped).
          instrument:  t.instrument || s.instrument || "NIFTY",
          isFutures:   t.isFutures === true || t.instrument === "NIFTY_FUTURES",
          side:        t.side || "",
          symbol:      t.symbol || "",
          qty:         t.qty || 0,
          entryPrice:  t.entryPrice,
          exitPrice:   t.exitPrice,
          spotAtEntry: t.spotAtEntry,
          spotAtExit:  t.spotAtExit,
          optionEntryLtp: t.optionEntryLtp,
          optionExitLtp:  t.optionExitLtp,
          entryTime:   t.entryTime || "",
          exitTime:    t.exitTime || "",
          pnl:         Number(t.pnl) || 0,
          pnlMode:     t.pnlMode || "",
          entryReason: t.entryReason || "",
          exitReason:  t.exitReason || "",
          optionStrike: t.optionStrike,
          optionType:  t.optionType || t.side || "",
          optionExpiry: t.optionExpiry || "",
          // Multi-market stamps — absent on older records (consolidationCore
          // supplies the defaults). Charges / gross only where the engine wrote them.
          market:        t.market || "",
          strategyId:    t.strategyId || "",
          tradeStrategy: t.strategy || "",
          exitCategory:  t.exitCategory || t.exitType || "",
          expiryDate:    t.expiryDate || t.optionExpiryDate || "",
          charges:       t.charges,
          grossPnl:      t.grossPnl,
  };
}

// ── Retired copy books (BN_* / FUT_* / CMX_* / SAIL_PIVOT_EMA_ST) ─────────────
// Their routes are gone but their books stay on disk, and their P&L still
// belongs in the consolidated history. DISCOVERED from the files (never listed
// by hand), always shown (no Settings toggle exists for them any more), and
// kept OUT of loadAllTrades() so the dashboard curve and the EOD reports keep
// counting only the strategies that run today.
const CMX_DIR = path.join(DATA_DIR, "cmx");
const RETIRED_SESSION_RE = /^((?:bn|fut|sail_pivot)_[a-z0-9_]+)_paper_trades\.json$/;
const RETIRED_CMX_RE     = /^(cmx_[a-z0-9_]+)_paper_trades\.json$/;

function _listDir(dir) { try { return fs.readdirSync(dir); } catch (_) { return []; } }

function retiredBooks() {
  const live = new Set(SOURCES.map((src) => path.basename(src.file)));
  const out = [];
  for (const n of _listDir(DATA_DIR)) {
    const m = RETIRED_SESSION_RE.exec(n);
    if (m && !live.has(n)) out.push({ mode: m[1].toUpperCase(), logKey: m[1], file: path.join(DATA_DIR, n), kind: "sessions" });
  }
  for (const n of _listDir(CMX_DIR)) {
    const m = RETIRED_CMX_RE.exec(n);
    if (m) out.push({ mode: m[1].toUpperCase(), logKey: m[1], file: path.join(CMX_DIR, n), kind: "days" });
  }
  return out.sort((a, b) => a.mode.localeCompare(b.mode));
}

function _fileSig(files) {
  let sig = "";
  for (const f of files) {
    try { const st = fs.statSync(f); sig += `${f}:${st.mtimeMs}:${st.size}|`; }
    catch (_) { sig += `${f}:0|`; }
  }
  return sig;
}

// Commodity books: { days: { 'YYYY-MM-DD': { trades: [...] } } } — the day key
// IS the IST trading day, exactly what the commodity history page grouped by.
function flattenDays(mode, data, out) {
  for (const [date, d] of Object.entries((data && data.days) || {})) {
    for (const t of ((d && d.trades) || [])) out.push(flatRow(mode, istDayFromAny(date), {}, t));
  }
}

let _retiredCache = null, _retiredSig = null;
function loadRetiredTrades() {
  const books = retiredBooks();
  const sig = _fileSig(books.map((b) => b.file));
  if (_retiredCache && sig === _retiredSig) return _retiredCache;
  const out = [];
  for (const b of books) {
    const data = safeRead(b.file);
    if (b.kind === "days") flattenDays(b.mode, data, out);
    else flattenSessions(b.mode, data, out);
  }
  out.sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  _retiredCache = { books, trades: out };
  _retiredSig = sig;
  return _retiredCache;
}

// ── Post-exit moves (utils/postExitTracker → post_exit/YYYY-MM-DD.jsonl) ─────
// Joined to a trade by book key + day + side + exit time (the tracker copies the
// trade's own exitTime string), falling back to the exit spot.
function _postExitDir() {
  try { return require("../utils/postExitTracker").OUT_DIR; } catch (_) { return path.join(DATA_DIR, "post_exit"); }
}
let _peCache = null, _peSig = null;
function loadPostExitIndex() {
  const dir = _postExitDir();
  const files = _listDir(dir).filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).map((n) => path.join(dir, n));
  const sig = _fileSig(files);
  if (_peCache && sig === _peSig) return _peCache;
  const idx = new Map();
  for (const f of files) {
    let text = "";
    try { text = fs.readFileSync(f, "utf-8"); } catch (_) { continue; }
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let r;
      try { r = JSON.parse(line); } catch (_) { continue; }
      if (!r || !r.mode || !r.date) continue;
      // Journal-era records carry the trade's id — the exact join.
      if (r.tradeId) idx.set(`id:${r.tradeId}`, r);
      const base = `${String(r.mode).toLowerCase()}|${r.date}|${String(r.side || "").toUpperCase()}`;
      if (r.exitTime) idx.set(`${base}|t:${r.exitTime}`, r);
      if (r.spotAtExit != null) idx.set(`${base}|s:${Number(r.spotAtExit)}`, r);
    }
  }
  _peCache = idx;
  _peSig = sig;
  return idx;
}

function _peFields(rec, exitTime) {
  if (!rec) return null;
  const b = rec.bestAfterExit, w = rec.worstAfterExit;
  if (!b && !w) return null;
  let minsToBest = null;
  const ex = CC.clockSecs(exitTime || rec.exitTime);
  const bt = b ? CC.clockSecs(b.time) : null;
  if (ex != null && bt != null) minsToBest = Math.max(0, Math.round((bt - ex) / 60));
  const pts = (m) => (rec[m] && rec[m].pts != null ? rec[m].pts : null);
  return {
    bestPts: b ? b.pts : null, bestTime: b ? b.time : "", minsToBest,
    worstPts: w ? w.pts : null, worstTime: w ? w.time : "",
    p5: pts("plus5m"), p15: pts("plus15m"), p30: pts("plus30m"), p60: pts("plus60m"),
  };
}

/**
 * Every trade the consolidated page shows: the ENABLED strategies (as
 * loadAllTrades) plus the retired copy books, each row stamped with its
 * market, strategy id, direction, exit bucket, expiry-day flag, gross /
 * charges and post-exit move. New objects — the cached loadAllTrades() rows
 * (shared with /data and the EOD reports) are never mutated.
 */
// A (strategy, market) pair's book whose switch is OFF: hidden from the dashboard
// and EOD reports like any disabled strategy, but its history stays on the
// consolidated page — as it did while the old NIFTY BANK / FUT twins were retired.
const _PAIR_MODES = new Set(require("../config/pairs").runnable().map(p => p.envPrefix));
function loadConsolidatedTrades() {
  const live = loadAllTrades().concat(
    _loadAllTradesUnfiltered().filter((t) => _PAIR_MODES.has(t.mode) && !_modeEnabled(t.mode)));
  const retired = loadRetiredTrades();
  const pe = loadPostExitIndex();
  const logKeyOf = {};
  for (const src of SOURCES) logKeyOf[src.mode] = path.basename(src.file).replace(/_paper_trades\.json$/, "");
  const retiredModes = new Set();
  for (const b of retired.books) { logKeyOf[b.mode] = b.logKey; retiredModes.add(b.mode); }
  const known = {};
  for (const src of SOURCES) known[CC.baseStrategyOfMode(src.mode)] = true;
  const expMemo = new Map();
  const rows = [];
  for (const t of live.concat(retired.trades)) {
    const logKey = logKeyOf[t.mode] || t.mode.toLowerCase();
    const market = CC.marketOf(logKey, t);
    const ek = `${market}|${t.date}|${t.expiryDate || ""}`;
    if (!expMemo.has(ek)) expMemo.set(ek, CC.expiryFlag(market, t.date, t));
    const charges = CC.num(t.charges);
    const grossOwn = CC.num(t.grossPnl);
    const side = String(t.side || "").toUpperCase();
    const ex = extraOf(t);
    const jid = ex && ex.journalId;
    const peRec = (jid && pe.get(`id:${jid}`))
               || pe.get(`${logKey}|${t.date}|${side}|t:${t.exitTime}`)
               || (t.spotAtExit != null ? pe.get(`${logKey}|${t.date}|${side}|s:${Number(t.spotAtExit)}`) : null);
    const row = {
      ...t,
      logKey,
      market,
      strategyId: CC.strategyOf(t.mode, t, known),
      retired: retiredModes.has(t.mode),
      dir: CC.dirOf(t.side),
      exitCat: CC.exitCategory(t),
      isExpiry: expMemo.get(ek),
      charges,
      gross: grossOwn != null ? grossOwn : (charges != null ? t.pnl + charges : t.pnl),
      postExit: _peFields(peRec, t.exitTime),
      // The trade journal's id (null = recorded before journals / route not
      // hooked yet) — the detail sheet fetches the journal by it.
      journalId: jid || null,
    };
    if (ex) _rowExtra.set(row, ex);
    rows.push(row);
  }
  rows.sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  return { trades: rows, retiredBooks: retired.books };
}

/** Book files to search for `mode` (null = every live + retired book). */
function _bookFilesFor(mode) {
  const out = [];
  for (const src of SOURCES) if (!mode || src.mode === mode) out.push({ file: src.file, kind: "sessions" });
  for (const b of retiredBooks()) if (!mode || b.mode === mode) out.push({ file: b.file, kind: b.kind });
  return out;
}

/**
 * Journals by id, read from the books on demand (a Map id → journal). `mode`
 * narrows the search to that strategy's book (the detail sheet); without it
 * every book is read (the daily export, once a day).
 */
function journalsFor(ids, mode) {
  const want = new Set((ids || []).filter(Boolean).map(String));
  const found = new Map();
  if (!want.size) return found;
  const take = (t) => {
    const j = t && t.journal;
    if (j && j.id != null && want.has(String(j.id))) found.set(String(j.id), j);
  };
  for (const b of _bookFilesFor(mode)) {
    const data = safeRead(b.file);
    if (b.kind === "days") for (const d of Object.values((data && data.days) || {})) for (const t of ((d && d.trades) || [])) take(t);
    else for (const s of ((data && data.sessions) || [])) for (const t of (s.trades || [])) take(t);
    if (found.size === want.size) break;
  }
  return found;
}

/** The full post-exit record for a consolidated row (by trade id first). */
function postExitRecordFor(row) {
  if (!row) return null;
  const pe = loadPostExitIndex();
  const side = String(row.side || "").toUpperCase();
  return (row.journalId && pe.get(`id:${row.journalId}`))
      || pe.get(`${row.logKey}|${row.date}|${side}|t:${row.exitTime}`)
      || (row.spotAtExit != null ? pe.get(`${row.logKey}|${row.date}|${side}|s:${Number(row.spotAtExit)}`) : null)
      || null;
}

// Display order for the Market filter; any other market a record names is
// appended after these, so a new market needs no edit here to be filterable.
const MARKET_ORDER = ["NIFTY", "NIFTY_FUT", "BANKNIFTY", "SENSEX", "CRUDE", "GOLD", "SILVER", "SAIL", "STOCKS"];
const MARKET_LABEL = { NIFTY_FUT: "NIFTY FUT", BANKNIFTY: "BANK NIFTY" };

// Filter dropdown contents, built from the trades the page actually holds.
function filterOptions(trades) {
  const label = {};
  for (const src of SOURCES) label[src.mode] = src.label;
  const mkts = new Set(trades.map((t) => t.market));
  const markets = [...MARKET_ORDER.filter((m) => mkts.has(m)), ...[...mkts].filter((m) => !MARKET_ORDER.includes(m)).sort()]
    .map((m) => ({ value: m, label: MARKET_LABEL[m] || m }));
  const ids = new Set(enabledSources().map((src) => CC.baseStrategyOfMode(src.mode)));
  for (const t of trades) ids.add(t.strategyId);
  const order = SOURCES.map((src) => src.mode);
  const strategies = [...ids].sort((a, b) => {
    const ia = order.indexOf(a), ib = order.indexOf(b);
    return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib) || a.localeCompare(b);
  }).map((id) => ({ value: id, label: label[id] || id }));
  return { markets, strategies };
}

function _escAttr(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

router.get("/", (req, res) => {
  const { trades, retiredBooks: retired } = loadConsolidatedTrades();
  const opts = filterOptions(trades);
  // Modes the page has rows for, in page order: enabled strategies first, then
  // any retired copy book that holds trades.
  const shownModes = [...enabledSources().map((src) => src.mode),
                      ...retired.map((b) => b.mode).filter((m) => trades.some((t) => t.mode === m))];
  const modeLabel = {};
  for (const src of SOURCES) modeLabel[src.mode] = src.label;
  for (const b of retired) modeLabel[b.mode] = b.mode + " (retired)";
  const stratLabel = Object.fromEntries(opts.strategies.map((o) => [o.value, o.label]));

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  ${faviconLink()}
  <title>ௐ Palani Andawar Thunai ॐ — Consolidation</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;600&display=swap" rel="stylesheet"/>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js"></script>
  <script>(function(){ if ('${resolveTheme()}' === 'light') document.documentElement.setAttribute('data-theme', 'light'); })();</script>
  <style>
    *{box-sizing:border-box;margin:0;padding:0;}
    body{font-family:'Inter',sans-serif;background:#040c18;color:#e0eaf8;overflow-x:hidden;}
    ${sidebarCSS()}
    ${modalCSS()}
    .main-content{flex:1;margin-left:200px;padding:18px 22px 40px;min-height:100vh;}
    @media(max-width:768px){.main-content{margin-left:0;padding:14px;}}
    .page-title{font-size:1.1rem;font-weight:700;color:#e0eaf8;margin-bottom:2px;}
    .page-sub{font-size:0.72rem;color:var(--muted-1,#8ba1c2);margin-bottom:14px;}
    .stat-grid{display:grid;grid-template-columns:repeat(8,1fr);gap:10px;margin-bottom:16px;}
    @media(max-width:1400px){.stat-grid{grid-template-columns:repeat(4,1fr);}}
    @media(max-width:900px){.stat-grid{grid-template-columns:repeat(3,1fr);}}
    @media(max-width:560px){.stat-grid{grid-template-columns:repeat(2,1fr);}}
    .sc{background:#07111f;border:0.5px solid #0e1e36;border-radius:10px;padding:12px 14px;position:relative;overflow:hidden;}
    .sc::before{content:'';position:absolute;top:0;left:0;width:3px;height:100%;background:var(--accent,#3b82f6);}
    .sc-label{font-size:0.55rem;text-transform:uppercase;letter-spacing:1.2px;color:var(--muted-2,#6d85a8);margin-bottom:5px;font-family:'IBM Plex Mono',monospace;}
    .sc-val{font-size:1.15rem;font-weight:700;font-family:'IBM Plex Mono',monospace;color:#e0eaf8;}
    .sc-sub{font-size:0.6rem;color:var(--muted-1,#8ba1c2);margin-top:3px;}

    .panel{background:#07111f;border:0.5px solid #0e1e36;border-radius:10px;padding:14px 16px;margin-bottom:14px;}
    .panel h3{font-size:0.62rem;text-transform:uppercase;letter-spacing:1.4px;color:var(--muted-2,#6d85a8);margin-bottom:10px;font-family:'IBM Plex Mono',monospace;}

    .tbar{display:flex;align-items:center;gap:8px;padding:10px 12px;background:#07111f;border:0.5px solid #0e1e36;border-radius:10px;margin-bottom:12px;flex-wrap:wrap;}
    .tbar label{font-size:0.58rem;text-transform:uppercase;letter-spacing:1px;color:var(--muted-2,#6d85a8);font-family:'IBM Plex Mono',monospace;}
    .tbar input,.tbar select{background:#04090f;border:0.5px solid #0e1e36;color:#e0eaf8;padding:6px 10px;border-radius:6px;font-family:'IBM Plex Mono',monospace;font-size:0.72rem;outline:none;}
    .tbar input:focus,.tbar select:focus{border-color:#3b82f6;}
    .btn{background:#0d1320;border:1px solid #1a2236;color:#4a9cf5;padding:6px 12px;border-radius:6px;font-size:0.7rem;cursor:pointer;font-family:inherit;transition:all 0.15s;}
    .btn:hover{background:#0a1e3d;border-color:#3b82f6;}
    .btn.copied{background:#064e3b!important;border-color:#10b981!important;color:#34d399!important;}
    .btn.warn{border-color:rgba(239,68,68,0.3);color:#ef4444;}
    .btn.warn:hover{background:rgba(239,68,68,0.08);}

    .tbl{width:100%;border-collapse:collapse;font-family:'IBM Plex Mono',monospace;font-size:0.72rem;}
    .tbl th{padding:8px 10px;text-align:left;font-size:0.56rem;text-transform:uppercase;letter-spacing:1px;color:var(--muted-2,#6d85a8);background:#04090f;border-bottom:0.5px solid #0e1e36;font-weight:600;position:sticky;top:0;}
    .tbl th.sortable{cursor:pointer;user-select:none;}
    .tbl th.sortable:hover{color:#4a9cf5;}
    .tbl th.sortable::after{content:'⇅';margin-left:4px;opacity:0.35;font-size:0.7rem;}
    .tbl th.sorted-asc::after{content:'↑';opacity:1;color:#3b82f6;}
    .tbl th.sorted-desc::after{content:'↓';opacity:1;color:#3b82f6;}
    .tbl td{padding:7px 10px;border-top:0.5px solid #0e1e36;color:#c8d8f0;vertical-align:middle;}
    .tbl tr:hover td{background:rgba(59,130,246,0.04);}
    .tbl-wrap{overflow-x:auto;max-height:560px;overflow-y:auto;border:0.5px solid #0e1e36;border-radius:10px;}

    .pager{display:flex;align-items:center;gap:6px;margin-top:8px;flex-wrap:wrap;font-family:'IBM Plex Mono',monospace;font-size:0.66rem;color:var(--muted-1,#8ba1c2);}
    .pager label{font-size:0.55rem;text-transform:uppercase;letter-spacing:1px;color:var(--muted-2,#6d85a8);}
    .pager select{background:#04090f;border:0.5px solid #0e1e36;color:#e0eaf8;padding:3px 6px;border-radius:5px;font-family:inherit;font-size:0.66rem;outline:none;cursor:pointer;}
    .pager select:focus{border-color:#3b82f6;}
    .pager-info{margin:0 4px;color:var(--muted-1,#8ba1c2);}
    .pager-btn{padding:3px 8px;font-size:0.72rem;line-height:1;min-width:26px;}
    .pager-btn:disabled{opacity:0.35;cursor:not-allowed;}
    :root[data-theme="light"] .pager label{color:#4b5769!important;}
    :root[data-theme="light"] .pager select{background:#f8fafc!important;border-color:#e0e4ea!important;color:#334155!important;}
    :root[data-theme="light"] .pager,:root[data-theme="light"] .pager-info{color:#4b5769!important;}
    .badge{display:inline-block;padding:2px 7px;border-radius:4px;font-size:0.6rem;font-weight:700;}
    .badge-ce{background:rgba(16,185,129,0.12);color:#10b981;border:0.5px solid rgba(16,185,129,0.25);}
    .badge-pe{background:rgba(239,68,68,0.12);color:#ef4444;border:0.5px solid rgba(239,68,68,0.25);}
    /* Neutral slate first; the per-mode rules below override it (retired copy books keep the slate). */
    .badge-mode{padding:2px 7px;border-radius:4px;font-size:0.58rem;font-weight:700;letter-spacing:0.5px;background:rgba(148,163,184,0.12);color:#a5b4c8;border:0.5px solid rgba(148,163,184,0.3);}
    .badge-EMA_RSI_ST{background:rgba(59,130,246,0.12);color:#3b82f6;border:0.5px solid rgba(59,130,246,0.3);}
    .badge-EMA_RSI_ST_V2{background:rgba(56,189,248,0.12);color:#38bdf8;border:0.5px solid rgba(56,189,248,0.3);}
    .badge-ST_RSI_PIV_BB{background:rgba(163,230,53,0.12);color:#a3e635;border:0.5px solid rgba(163,230,53,0.3);}
    .badge-SAIL_VWAP_ST{background:rgba(253,164,175,0.12);color:#fda4af;border:0.5px solid rgba(253,164,175,0.3);}
    .badge-PIVOT_EMA_ST{background:rgba(56,189,248,0.12);color:#38bdf8;border:0.5px solid rgba(56,189,248,0.3);}
    .badge-GAP_RUNAWAY{background:rgba(167,139,250,0.12);color:#a78bfa;border:0.5px solid rgba(167,139,250,0.3);}
    .badge-GAP_RUNAWAY_STK{background:rgba(192,132,252,0.12);color:#c084fc;border:0.5px solid rgba(192,132,252,0.3);}
    .badge-BB_RSI{background:rgba(245,158,11,0.12);color:#f59e0b;border:0.5px solid rgba(245,158,11,0.3);}
    .badge-PA{background:rgba(168,85,247,0.12);color:#a855f7;border:0.5px solid rgba(168,85,247,0.3);}

    .roll-grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;}
    @media(max-width:1100px){.roll-grid{grid-template-columns:1fr;}}
    .chart-wrap{position:relative;height:240px;}
    .empty{text-align:center;padding:40px 20px;color:var(--muted-1,#8ba1c2);font-size:0.8rem;}

    /* ── Analytics panel (parity with paper-history pages) ───────────────── */
    .ana-panel{margin-bottom:14px;}
    .ana-row{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px;}
    @media(max-width:900px){.ana-row{grid-template-columns:1fr;}}
    .ana-card{background:#07111f;border:0.5px solid #0e1e36;border-radius:10px;padding:12px 14px;position:relative;}
    .ana-card h3{font-size:0.6rem;text-transform:uppercase;letter-spacing:1.2px;color:var(--muted-2,#6d85a8);margin-bottom:10px;font-family:'IBM Plex Mono',monospace;}
    .ana-chart-wrap{position:relative;height:220px;}
    .ana-row3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:12px;}
    @media(max-width:900px){.ana-row3{grid-template-columns:1fr;}}
    .ana-mini{background:#07111f;border:0.5px solid #0e1e36;border-radius:10px;padding:12px 14px;}
    .ana-mini h3{font-size:0.58rem;text-transform:uppercase;letter-spacing:1.2px;color:var(--muted-2,#6d85a8);margin-bottom:8px;font-family:'IBM Plex Mono',monospace;}
    .ana-tbl{width:100%;border-collapse:collapse;}
    .ana-tbl th{text-align:left;font-size:0.55rem;text-transform:uppercase;letter-spacing:0.8px;color:var(--muted-2,#6d85a8);padding:5px 8px;border-bottom:0.5px solid #0e1e36;font-family:'IBM Plex Mono',monospace;}
    .ana-tbl td{padding:5px 8px;font-size:0.72rem;font-family:'IBM Plex Mono',monospace;color:#c8d8f0;border-bottom:0.5px solid #060d18;}
    .ana-tbl tr:hover td{background:rgba(59,130,246,0.04);}
    .ana-stat{display:flex;align-items:baseline;gap:6px;margin-bottom:6px;}
    .ana-stat-val{font-size:1rem;font-weight:700;font-family:'IBM Plex Mono',monospace;}
    .ana-stat-label{font-size:0.62rem;color:var(--muted-2,#6d85a8);}
    .ana-section-title{font-size:0.6rem;text-transform:uppercase;letter-spacing:1.5px;color:#ef4444;font-weight:700;margin:16px 0 12px;padding-top:12px;border-top:0.5px solid #0e1e36;font-family:'IBM Plex Mono',monospace;}
    .ana-section-title.gain{color:#10b981;}
    .ana-section-title.cross{color:#a855f7;}

    /* Per-table filter bar + sortable headers + pager */
    .ana-tbl-bar{display:flex;align-items:center;gap:6px;margin-bottom:6px;flex-wrap:wrap;}
    .ana-tbl-filter{flex:1;min-width:120px;background:#04090f;border:0.5px solid #0e1e36;color:#e0eaf8;padding:4px 8px;border-radius:5px;font-family:'IBM Plex Mono',monospace;font-size:0.66rem;outline:none;}
    .ana-tbl-filter:focus{border-color:#3b82f6;}
    .ana-tbl-count{font-size:0.55rem;color:var(--muted-2,#6d85a8);font-family:'IBM Plex Mono',monospace;text-transform:uppercase;letter-spacing:0.6px;}
    .ana-sortable{cursor:pointer;user-select:none;white-space:nowrap;}
    .ana-sortable::after{content:'⇅';margin-left:3px;opacity:0.35;font-size:0.65rem;}
    .ana-sortable:hover{color:#4a9cf5;}
    .ana-sortable.ana-sorted-asc::after{content:'↑';opacity:1;color:#3b82f6;}
    .ana-sortable.ana-sorted-desc::after{content:'↓';opacity:1;color:#3b82f6;}
    .ana-tbl-pager{display:flex;align-items:center;gap:5px;margin-top:6px;flex-wrap:wrap;font-family:'IBM Plex Mono',monospace;font-size:0.6rem;color:var(--muted-2,#6d85a8);}
    .ana-tbl-pager label{font-size:0.55rem;text-transform:uppercase;letter-spacing:0.6px;color:var(--muted-2,#6d85a8);}
    .ana-tbl-pager select{background:#04090f;border:0.5px solid #0e1e36;color:#e0eaf8;padding:2px 5px;border-radius:4px;font-family:inherit;font-size:0.62rem;outline:none;cursor:pointer;}
    .ana-tbl-pager select:focus{border-color:#3b82f6;}
    .ana-tbl-pager-info{margin:0 4px;}
    .ana-tbl-pager .btn{padding:2px 6px;min-width:22px;font-size:0.68rem;line-height:1;}
    .ana-tbl-pager .btn:disabled{opacity:0.35;cursor:not-allowed;}

    /* Light theme overrides for new controls */
    :root[data-theme="light"] .ana-tbl-filter{background:#f8fafc!important;border-color:#e0e4ea!important;color:#334155!important;}
    :root[data-theme="light"] .ana-tbl-count,
    :root[data-theme="light"] .ana-tbl-pager,
    :root[data-theme="light"] .ana-tbl-pager label{color:#4b5769!important;}
    :root[data-theme="light"] .ana-tbl-pager select{background:#f8fafc!important;border-color:#e0e4ea!important;color:#334155!important;}

    /* Light theme overrides for analytics */
    :root[data-theme="light"] .ana-card,
    :root[data-theme="light"] .ana-mini{background:#fff!important;border-color:#e0e4ea!important;box-shadow:0 1px 3px rgba(0,0,0,0.06)!important;}
    :root[data-theme="light"] .ana-card h3,
    :root[data-theme="light"] .ana-mini h3{color:#4b5769!important;}
    :root[data-theme="light"] .ana-tbl th{color:#4b5769!important;border-bottom-color:#e0e4ea!important;background:#f1f5f9!important;}
    :root[data-theme="light"] .ana-tbl td{color:#334155!important;border-color:#e0e4ea!important;}
    :root[data-theme="light"] .ana-tbl tr:hover td{background:rgba(59,130,246,0.05)!important;}
    :root[data-theme="light"] .ana-stat-label{color:#4b5769!important;}
    :root[data-theme="light"] .ana-section-title{border-color:#e0e4ea!important;}

    /* Light theme overrides */
    :root[data-theme="light"] body{background:#f4f6f9!important;color:#334155!important;}
    :root[data-theme="light"] .main-content{background:#f4f6f9!important;}
    :root[data-theme="light"] .page-title{color:#1e293b!important;}
    :root[data-theme="light"] .page-sub{color:#5c6b7f!important;}
    :root[data-theme="light"] .sc{background:#fff!important;border-color:#e0e4ea!important;box-shadow:0 1px 3px rgba(0,0,0,0.06)!important;}
    :root[data-theme="light"] .sc-label{color:#4b5769!important;}
    :root[data-theme="light"] .sc-val{color:#1e293b!important;}
    :root[data-theme="light"] .sc-sub{color:#5c6b7f!important;}
    :root[data-theme="light"] .panel{background:#fff!important;border-color:#e0e4ea!important;box-shadow:0 1px 3px rgba(0,0,0,0.06)!important;}
    :root[data-theme="light"] .panel h3{color:#4b5769!important;}
    :root[data-theme="light"] .tbar{background:#fff!important;border-color:#e0e4ea!important;}
    :root[data-theme="light"] .tbar label{color:#4b5769!important;}
    :root[data-theme="light"] .tbar input,.tbar select{background:#f8fafc!important;border-color:#e0e4ea!important;color:#334155!important;}
    :root[data-theme="light"] .btn{background:#f8fafc!important;border-color:#e0e4ea!important;color:#2563eb!important;}
    :root[data-theme="light"] .btn:hover{background:#eff6ff!important;border-color:#3b82f6!important;}
    :root[data-theme="light"] .tbl th{background:#f1f5f9!important;color:#4b5769!important;border-bottom-color:#e0e4ea!important;}
    :root[data-theme="light"] .tbl td{border-color:#e0e4ea!important;color:#334155!important;}
    :root[data-theme="light"] .tbl tr:hover td{background:rgba(59,130,246,0.05)!important;}
    :root[data-theme="light"] .tbl-wrap{border-color:#e0e4ea!important;}
    :root[data-theme="light"] .empty{color:#5c6b7f!important;}

    @media(max-width:768px){
      .stat-grid{grid-template-columns:repeat(2,1fr);}
      .tbl{font-size:0.65rem;}
      .tbl th,.tbl td{padding:5px 6px;}
    }

    /* ── Multi-market filters, totals, breakdowns ─────────────────────────── */
    .paper-pill{display:inline-block;padding:1px 7px;margin-right:4px;border-radius:4px;font-size:0.58rem;font-weight:700;letter-spacing:0.8px;background:rgba(59,130,246,0.14);color:#60a5fa;border:0.5px solid rgba(59,130,246,0.35);vertical-align:1px;}
    .num{text-align:right;font-variant-numeric:tabular-nums;}
    .tbl th.num{text-align:right;}
    .sub-num{font-size:0.58rem;font-weight:400;color:var(--muted-1,#8ba1c2);}
    .muted{color:var(--muted-2,#6d85a8);}
    .tbl td.pos,.tbl td .pos{color:#10b981!important;}
    .tbl td.neg,.tbl td .neg{color:#ef4444!important;}
    .pe-best{color:#10b981;white-space:nowrap;}
    .pe-worst{color:#ef4444;white-space:nowrap;font-size:0.62rem;}
    .mkt-pill{display:inline-block;padding:1px 6px;border-radius:4px;font-size:0.58rem;font-weight:700;letter-spacing:0.4px;background:rgba(148,163,184,0.12);color:#a5b4c8;border:0.5px solid rgba(148,163,184,0.3);white-space:nowrap;}
    .exp-tag,.retired-tag{display:inline-block;padding:0 5px;border-radius:3px;font-size:0.52rem;font-weight:700;letter-spacing:0.5px;vertical-align:1px;}
    .exp-tag{background:rgba(245,158,11,0.14);color:#f59e0b;}
    .retired-tag{background:rgba(148,163,184,0.12);color:#94a3b8;}
    .fgrp{display:flex;align-items:center;gap:6px;}
    .fgrp.factions{gap:6px;}
    .tbar-count{margin-left:auto;font-size:0.7rem;color:var(--muted-1,#8ba1c2);}
    .fsheet-bar,.fsheet-head,.fsheet-backdrop{display:none;}
    .fact-n{color:#f59e0b;font-weight:700;}
    .bd-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;}
    @media(max-width:900px){.bd-grid{grid-template-columns:1fr;}}
    .bd-wrap{max-height:340px;}
    .bd-key{font-weight:600;white-space:nowrap;}
    .empty-cell{text-align:center;color:var(--muted-1,#8ba1c2);padding:18px!important;}
    .tot-empty{grid-column:1 / -1;}
    :root[data-theme="light"] .paper-pill{background:#eff6ff!important;color:#1d4ed8!important;border-color:#bfdbfe!important;}
    :root[data-theme="light"] .mkt-pill{background:#f1f5f9;color:#475569;border-color:#cbd5e1;}
    .sc-val.pos{color:#10b981!important;} .sc-val.neg{color:#ef4444!important;}
    :root[data-theme="light"] .sc-val.pos{color:#047857!important;} :root[data-theme="light"] .sc-val.neg{color:#b91c1c!important;}
    :root[data-theme="light"] .tbl td.pos,:root[data-theme="light"] .tbl td .pos,:root[data-theme="light"] .pe-best{color:#047857!important;}
    :root[data-theme="light"] .tbl td.neg,:root[data-theme="light"] .tbl td .neg,:root[data-theme="light"] .pe-worst{color:#b91c1c!important;}
    :root[data-theme="light"] .sub-num,:root[data-theme="light"] .tbar-count{color:#5c6b7f!important;}
    :root[data-theme="light"] .fsheet{background:#fff!important;}

    /* ── Phone (≤600px): filters in a bottom sheet, trades as cards ──────── */
    @media(max-width:600px){
      .main-content{padding:12px max(16px, env(safe-area-inset-right)) calc(32px + env(safe-area-inset-bottom)) max(16px, env(safe-area-inset-left));}
      .btn{min-height:44px;min-width:44px;}
      /* Sticky under any top banner; clears the fixed 44px hamburger on the left. */
      .fsheet-bar{display:flex;align-items:center;gap:10px;position:sticky;top:var(--banner-h,0px);z-index:40;padding:8px 0 8px 50px;margin:0 0 8px;background:#040c18;}
      :root[data-theme="light"] .fsheet-bar{background:#f4f6f9;}
      .fsheet-open{font-weight:700;}
      .fcount-m{font-size:0.68rem;color:var(--muted-1,#8ba1c2);font-family:'IBM Plex Mono',monospace;line-height:1.3;}
      .tbar.fsheet{position:fixed;left:0;right:0;bottom:0;z-index:310;margin:0;border-radius:14px 14px 0 0;
        display:grid;grid-template-columns:1fr 1fr;gap:10px 12px;align-items:end;max-height:85vh;overflow-y:auto;
        padding:14px max(16px, env(safe-area-inset-right)) calc(16px + env(safe-area-inset-bottom)) max(16px, env(safe-area-inset-left));
        transform:translateY(105%);visibility:hidden;transition:transform 0.2s ease, visibility 0s linear 0.2s;box-shadow:0 -12px 32px rgba(0,0,0,0.5);}
      body.fsheet-on .tbar.fsheet{transform:none;visibility:visible;transition:transform 0.2s ease;}
      body.fsheet-on{overflow:hidden;}
      .fsheet-backdrop{position:fixed;inset:0;z-index:300;background:rgba(0,0,0,0.5);}
      body.fsheet-on .fsheet-backdrop{display:block;}
      .fsheet-head{display:flex;grid-column:1 / -1;align-items:center;justify-content:space-between;font-size:0.9rem;}
      .fgrp{flex-direction:column;align-items:stretch;gap:4px;}
      .fgrp.fsearch,.fgrp.factions{grid-column:1 / -1;}
      .fgrp.factions{flex-direction:row;}
      .fgrp.factions .btn{flex:1;}
      .tbar.fsheet select,.tbar.fsheet input{min-height:44px;font-size:16px;width:100%;}
      .tbar.fsheet .tbar-count{grid-column:1 / -1;margin:0;}
      .pager select,.pager-btn{min-height:44px;}
      .stat-grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;}
      .sc{padding:10px 12px;}
      .sc-val{font-size:1rem;overflow-wrap:anywhere;}
      /* Trades table → one card per trade; each cell prints its own heading. */
      #tradesTbl{font-size:0.74rem;}
      #tradesTbl thead{display:none;}
      #tradesTbl, #tradesTbl tbody{display:block;width:100%;}
      #tradesTbl tr{display:grid;grid-template-columns:1fr 1fr;gap:2px 12px;padding:10px 12px;border-bottom:0.5px solid #0e1e36;}
      #tradesTbl td{display:flex;justify-content:space-between;align-items:baseline;gap:8px;border:0;padding:3px 0;min-width:0;max-width:none!important;}
      #tradesTbl td::before{content:attr(data-label);font-size:0.56rem;text-transform:uppercase;letter-spacing:0.8px;color:var(--muted-2,#6d85a8);flex-shrink:0;}
      #tradesTbl td.c-no{display:none;}
      #tradesTbl td.c-strat{grid-column:1 / -1;justify-content:flex-start;}
      #tradesTbl td.c-strat::before,#tradesTbl td.c-copy::before{content:none;}
      #tradesTbl td.c-pnl{grid-column:1 / -1;font-size:0.95rem;}
      #tradesTbl td.c-reason,#tradesTbl td.c-sym,#tradesTbl td.c-pe{grid-column:1 / -1;white-space:normal!important;}
      #tradesTbl td.c-pe{display:flex;}
      #tradesTbl td.c-pe .pe-best,#tradesTbl td.c-pe .pe-worst{display:inline;margin-left:8px;font-size:0.74rem;}
      #tradesTbl td.c-copy{grid-column:1 / -1;justify-content:flex-end;}
      .tbl-wrap{max-height:none;}
      :root[data-theme="light"] #tradesTbl tr{border-color:#e0e4ea;}
    }

    /* ── Trade detail sheet (tap a trade) ─────────────────────────────────── */
    #tradesTbl tbody tr{cursor:pointer;}
    .td-btns{display:flex;gap:6px;justify-content:flex-end;}
    .td-btns .btn{min-width:44px;min-height:32px;}
    .td-backdrop{display:none;position:fixed;inset:0;z-index:400;background:rgba(0,0,0,0.55);}
    .td-sheet{position:fixed;top:0;right:0;bottom:0;z-index:410;width:min(460px,100%);background:#07111f;border-left:0.5px solid #0e1e36;
      transform:translateX(100%);visibility:hidden;transition:transform 0.2s ease,visibility 0s linear 0.2s;display:flex;flex-direction:column;}
    body.td-on .td-backdrop{display:block;}
    body.td-on .td-sheet{transform:none;visibility:visible;transition:transform 0.2s ease;}
    body.td-on{overflow:hidden;}
    .td-head{display:flex;align-items:center;gap:10px;padding:12px 14px;border-bottom:0.5px solid #0e1e36;padding-top:max(12px,env(safe-area-inset-top));}
    .td-title{flex:1;min-width:0;font-size:0.82rem;font-weight:700;overflow-wrap:anywhere;}
    .td-close{min-width:44px;min-height:44px;font-size:0.9rem;}
    .td-body{flex:1;overflow-y:auto;overflow-x:hidden;padding:10px 14px calc(24px + env(safe-area-inset-bottom));-webkit-overflow-scrolling:touch;}
    .td-sec{margin:0 0 14px;}
    .td-sec h4{font-size:0.58rem;text-transform:uppercase;letter-spacing:1.2px;color:var(--muted-2,#6d85a8);margin:0 0 6px;font-family:'IBM Plex Mono',monospace;}
    .td-why{font-size:0.8rem;line-height:1.4;margin-bottom:6px;overflow-wrap:anywhere;}
    .td-kv{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:4px 12px;font-family:'IBM Plex Mono',monospace;font-size:0.72rem;}
    .td-kv div{display:flex;justify-content:space-between;gap:6px;min-width:0;border-bottom:0.5px solid #0b1728;padding:3px 0;}
    .td-kv span:first-child{color:var(--muted-2,#6d85a8);flex-shrink:0;}
    .td-kv span:last-child{text-align:right;overflow-wrap:anywhere;min-width:0;}
    .td-nr{font-size:0.72rem;color:var(--muted-1,#8ba1c2);font-style:italic;}
    .td-tl{list-style:none;margin:0;padding:0;font-family:'IBM Plex Mono',monospace;font-size:0.7rem;}
    .td-tl li{padding:6px 0 6px 12px;border-left:2px solid #1e3a5f;margin-left:4px;overflow-wrap:anywhere;}
    .td-tl li b{color:#e0eaf8;}
    .td-tl .k-trail,.td-tl .k-lock{border-color:#f59e0b;}
    .td-tl .k-breakeven{border-color:#10b981;}
    .td-tl .k-target{border-color:#3b82f6;}
    .td-spark{width:100%;height:60px;display:block;}
    .td-export{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:8px;}
    .td-export input{min-height:44px;font-size:16px;background:#04090f;border:0.5px solid #0e1e36;color:#e0eaf8;border-radius:6px;padding:0 10px;}
    .td-export .btn{min-height:44px;}
    .td-export-msg{font-size:0.7rem;color:var(--muted-1,#8ba1c2);overflow-wrap:anywhere;}
    @media(max-width:768px){
      .td-sheet{top:auto;left:0;right:0;width:100%;max-height:88vh;border-left:0;border-top:0.5px solid #0e1e36;border-radius:14px 14px 0 0;transform:translateY(100%);}
      .td-head{padding-top:12px;}
      .td-btns .btn{min-height:44px;}
      .td-kv{grid-template-columns:minmax(0,1fr);}
    }
    :root[data-theme="light"] .td-sheet{background:#fff;border-color:#e0e4ea;}
    :root[data-theme="light"] .td-head{border-color:#e0e4ea;}
    :root[data-theme="light"] .td-kv div{border-color:#eef1f5;}
    :root[data-theme="light"] .td-tl li b{color:#1e293b;}
    :root[data-theme="light"] .td-export input{background:#f8fafc;border-color:#e0e4ea;color:#334155;}
  </style>
</head>
<body>
<div class="app-shell">
  ${buildSidebar('consolidation', false)}
  <div class="main-content">
    <h1 class="page-title">🧾 Consolidation</h1>
    <div class="page-sub"><span class="paper-pill">PAPER</span> Every paper trade across all strategies and markets${retired.length ? ` — including ${retired.length} retired copy book${retired.length === 1 ? "" : "s"}` : ""}. Filters combine and live in the URL, so a view can be bookmarked.</div>

    <!-- Mobile: the filters live in a bottom sheet opened from this bar -->
    <div class="fsheet-bar">
      <button type="button" class="btn fsheet-open" id="fSheetOpen" onclick="openSheet()" aria-controls="fSheet" aria-expanded="false">⚙ Filters <span id="fActiveN" class="fact-n"></span></button>
      <span id="fCountM" class="fcount-m"></span>
    </div>
    <div class="fsheet-backdrop" id="fSheetBackdrop" onclick="closeSheet()"></div>

    <!-- Filter bar (a bottom sheet below 600px) -->
    <div class="tbar fsheet" id="fSheet" role="region" aria-label="Filters">
      <div class="fsheet-head"><strong>Filters</strong><button type="button" class="btn" onclick="closeSheet()" aria-label="Close filters">Done</button></div>
      <div class="fgrp"><label for="fMarket">Market</label>
      <select id="fMarket">
        <option value="">All markets</option>
        ${opts.markets.map((m) => `<option value="${_escAttr(m.value)}">${_escAttr(m.label)}</option>`).join("")}
      </select></div>
      <div class="fgrp"><label for="fStrat">Strategy</label>
      <select id="fStrat">
        <option value="">All strategies</option>
        ${opts.strategies.map((o) => `<option value="${_escAttr(o.value)}">${_escAttr(o.label)}</option>`).join("")}
      </select></div>
      <div class="fgrp"><label for="fPreset">Date</label>
      <select id="fPreset">
        ${CC.PRESETS.map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}
      </select></div>
      <div class="fgrp fcustom"><label for="fFrom">From</label>
      <input type="date" id="fFrom"/></div>
      <div class="fgrp fcustom"><label for="fTo">To</label>
      <input type="date" id="fTo"/></div>
      <div class="fgrp"><label for="fSide">Side</label>
      <select id="fSide">
        <option value="">All sides</option>
        <option value="CE">CE</option>
        <option value="PE">PE</option>
        <option value="LONG">Long (CE / buy)</option>
        <option value="SHORT">Short (PE / sell)</option>
      </select></div>
      <div class="fgrp"><label for="fResult">Result</label>
      <select id="fResult">
        <option value="">Wins &amp; losses</option>
        <option value="win">Wins only</option>
        <option value="loss">Losses only</option>
      </select></div>
      <div class="fgrp"><label for="fExit">Exit reason</label>
      <select id="fExit">
        <option value="">All exits</option>
        ${CC.EXIT_CATS.map((c) => `<option value="${_escAttr(c)}">${_escAttr(c)}</option>`).join("")}
      </select></div>
      <div class="fgrp"><label for="fExpiry">Expiry day</label>
      <select id="fExpiry">
        <option value="">Any day</option>
        <option value="expiry">Expiry day only</option>
        <option value="non">Non-expiry days</option>
      </select></div>
      <div class="fgrp fsearch"><label for="fSearch">Search</label>
      <input type="text" id="fSearch" placeholder="symbol / reason…" autocomplete="off"/></div>
      <div class="fgrp factions">
        <button class="btn" onclick="applyFilters()">Apply</button>
        <button class="btn" onclick="resetFilters()">Reset</button>
      </div>
      <span class="tbar-count" id="fCount"></span>
    </div>

    <!-- Totals for the filtered set -->
    <div class="stat-grid" id="totGrid" aria-live="polite"></div>

    <!-- Per-market / per-strategy breakdown -->
    <div class="bd-grid">
      <div class="panel">
        <h3>By market</h3>
        <div class="tbl-wrap bd-wrap"><table class="tbl bd-tbl" id="bdMarket"><thead><tr>
          <th>Market</th><th class="num">Trades</th><th class="num">WR</th><th class="num">Net P&amp;L</th><th class="num">PF</th><th class="num">Max DD</th>
        </tr></thead><tbody></tbody></table></div>
      </div>
      <div class="panel">
        <h3>By strategy</h3>
        <div class="tbl-wrap bd-wrap"><table class="tbl bd-tbl" id="bdStrat"><thead><tr>
          <th>Strategy</th><th class="num">Trades</th><th class="num">WR</th><th class="num">Net P&amp;L</th><th class="num">PF</th><th class="num">Max DD</th>
        </tr></thead><tbody></tbody></table></div>
      </div>
    </div>

    <!-- Bulk copy bar -->
    <div class="tbar">
      <label>Copy filtered as</label>
      <button class="btn" onclick="copyGroup('daily')">📋 Daily</button>
      <button class="btn" onclick="copyGroup('weekly')">📋 Weekly</button>
      <button class="btn" onclick="copyGroup('monthly')">📋 Monthly</button>
      <button class="btn" onclick="copyGroup('yearly')">📋 Yearly</button>
      <button class="btn" onclick="copyAll()">📋 All Trades</button>
      <button class="btn" onclick="downloadCSV()">⬇ CSV</button>
      <button class="btn" onclick="downloadAI()" title="Download the filtered trades as an AI-friendly Markdown report (summary + field legend + tables) — paste straight into an AI for analysis">🤖 AI</button>
      <button id="dvToggle" class="btn" onclick="toggleDayView()" style="margin-left:auto;" title="Day-wise P&L summary across all modes">👁 Day View</button>
      <button id="anaToggle" class="btn" onclick="toggleAnalytics()" title="Performance analytics across all modes (respects filters)">📊 Analytics</button>
    </div>

    <!-- Day View (toggleable) -->
    <div class="panel" id="dayViewPanel" style="display:none;">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;">
        <h3 style="margin:0;">Day View</h3>
        <span id="dvCount" style="font-size:0.62rem;color:var(--muted-1,#8ba1c2);font-family:'IBM Plex Mono',monospace;"></span>
        <button class="btn" onclick="copyDayView(event.target)" style="margin-left:auto;">📋 Copy Day View</button>
      </div>
      <div class="tbl-wrap" style="max-height:420px;">
        <table class="tbl" id="dayViewTbl">
          <thead><tr>
            <th>Date</th>
            <th>Trades</th>
            ${shownModes.map((m) => `<th>${_escAttr(modeLabel[m] || m)}</th>`).join("")}
            <th>Wins</th>
            <th>Losses</th>
            <th>P&amp;L</th>
            <th>Cumulative P&amp;L</th>
          </tr></thead>
          <tbody></tbody>
        </table>
      </div>
    </div>

    <!-- Analytics Panel (toggleable) -->
    <div id="anaPanel" class="ana-panel" style="display:none;">
      <!-- Cross-mode comparison (unique to consolidation) -->
      <div class="ana-mini" style="margin-bottom:12px;">
        <h3>🧭 Cross-Mode Comparison</h3>
        <div style="overflow-x:auto;">
          <table class="ana-tbl">
            <thead><tr>
              <th>Mode</th><th>Trades</th><th>Wins</th><th>Losses</th><th>WR%</th>
              <th>Net P&amp;L</th><th>Avg Win</th><th>Avg Loss</th><th>Profit Factor</th><th>Expectancy</th>
            </tr></thead>
            <tbody id="anaModeBody"></tbody>
          </table>
        </div>
      </div>

      <!-- Headline risk metrics + streaks (overall) -->
      <div class="ana-row3">
        <div class="ana-mini"><h3>📊 Risk Metrics (overall)</h3><div id="anaRiskMetrics"></div></div>
        <div class="ana-mini"><h3>🔥 Win / Loss Streaks</h3><div id="anaStreaks"></div></div>
        <div class="ana-mini"><h3>📅 Day-of-Week</h3><div style="overflow-x:auto;"><table class="ana-tbl"><thead><tr><th>Day</th><th>Trades</th><th>WR%</th><th>P&amp;L</th><th>Avg</th></tr></thead><tbody id="anaDowBody"></tbody></table></div></div>
      </div>

      <!-- Equity / Monthly / Drawdown / Hourly -->
      <div class="ana-row">
        <div class="ana-card"><h3>📈 Equity Curve (per-trade)</h3><div class="ana-chart-wrap"><canvas id="anaEquity"></canvas></div></div>
        <div class="ana-card"><h3>📊 Monthly P&amp;L</h3><div class="ana-chart-wrap"><canvas id="anaMonthly"></canvas></div></div>
      </div>
      <div class="ana-row">
        <div class="ana-card"><h3>📉 Drawdown</h3><div class="ana-chart-wrap"><canvas id="anaDrawdown"></canvas></div></div>
        <div class="ana-card"><h3>⏰ Hourly Performance</h3><div class="ana-chart-wrap"><canvas id="anaHourly"></canvas></div></div>
      </div>

      <!-- Reason breakdowns -->
      <div class="ana-row">
        <div class="ana-mini"><h3>📥 Entry Reason Breakdown</h3><div style="overflow-x:auto;max-height:320px;overflow-y:auto;"><table class="ana-tbl"><thead><tr><th>Reason</th><th>Mode</th><th>Count</th><th>Wins</th><th>Losses</th><th>WR%</th><th>P&amp;L</th><th>Avg</th></tr></thead><tbody id="anaEntryBody"></tbody></table></div></div>
        <div class="ana-mini"><h3>🚪 Exit Reason Breakdown</h3><div style="overflow-x:auto;max-height:320px;overflow-y:auto;"><table class="ana-tbl"><thead><tr><th>Reason</th><th>Mode</th><th>Count</th><th>P&amp;L</th><th>Avg</th></tr></thead><tbody id="anaExitBody"></tbody></table></div></div>
      </div>

      <!-- Loss analysis section -->
      <div class="ana-section-title">🔍 Loss Analysis</div>
      <div class="ana-row">
        <div class="ana-card"><h3>📊 Loss Distribution</h3><div class="ana-chart-wrap"><canvas id="anaLossDist"></canvas></div></div>
        <div class="ana-card"><h3>🔀 CE vs PE Performance</h3><div class="ana-chart-wrap"><canvas id="anaSidePerf"></canvas></div></div>
      </div>
      <div class="ana-row3">
        <div class="ana-mini"><h3>💀 Top 10 Worst Trades</h3><div style="overflow-x:auto;max-height:280px;overflow-y:auto;"><table class="ana-tbl"><thead><tr><th>Date</th><th>Mode</th><th>Side</th><th>P&amp;L</th><th>Exit</th></tr></thead><tbody id="anaWorstBody"></tbody></table></div></div>
        <div class="ana-mini"><h3>🔥 Consecutive Loss Streaks</h3><div style="overflow-x:auto;max-height:280px;overflow-y:auto;"><table class="ana-tbl"><thead><tr><th>Start</th><th>Trades</th><th>Total Loss</th><th>Avg Loss</th></tr></thead><tbody id="anaLossStreakBody"></tbody></table></div></div>
        <div class="ana-mini"><h3>📅 Worst Trading Days</h3><div style="overflow-x:auto;max-height:280px;overflow-y:auto;"><table class="ana-tbl"><thead><tr><th>Date</th><th>Trades</th><th>Day P&amp;L</th><th>Losses</th><th>Worst</th></tr></thead><tbody id="anaWorstDayBody"></tbody></table></div></div>
      </div>
      <div class="ana-row">
        <div class="ana-mini"><h3>🚪 Loss by Exit Reason</h3><div style="overflow-x:auto;"><table class="ana-tbl"><thead><tr><th>Reason</th><th>Loss Count</th><th>Total Loss</th><th>Avg Loss</th><th>% of Losses</th></tr></thead><tbody id="anaLossReasonBody"></tbody></table></div></div>
        <div class="ana-mini"><h3>⏰ Losing Hours</h3><div style="overflow-x:auto;"><table class="ana-tbl"><thead><tr><th>Hour</th><th>Losses</th><th>Loss P&amp;L</th><th>Avg Loss</th><th>Loss%</th></tr></thead><tbody id="anaLossHourBody"></tbody></table></div></div>
      </div>
      <div class="ana-row3">
        <div class="ana-mini" style="grid-column:1 / -1;"><h3>📆 Day-wise Loss</h3><div style="overflow-x:auto;max-height:320px;overflow-y:auto;"><table class="ana-tbl"><thead><tr><th>Date</th><th>Trades</th><th>Losing Trades</th><th>Gross Loss</th><th>Day Net</th></tr></thead><tbody id="anaDayLossBody"></tbody></table></div></div>
      </div>
      <div class="ana-row3">
        <div class="ana-mini" style="grid-column:1 / -1;"><h3>🕯️ Losses by Candles Held</h3><div style="overflow-x:auto;max-height:320px;overflow-y:auto;"><table class="ana-tbl"><thead><tr><th>Date</th><th>Mode</th><th>Side</th><th>Candles Held</th><th>Loss</th><th>Exit</th></tr></thead><tbody id="anaLossCandleBody"></tbody></table></div></div>
      </div>

      <!-- Best trades -->
      <div class="ana-section-title gain">🏆 Best Performance</div>
      <div class="ana-row3">
        <div class="ana-mini"><h3>🌟 Top 10 Best Trades</h3><div style="overflow-x:auto;max-height:280px;overflow-y:auto;"><table class="ana-tbl"><thead><tr><th>Date</th><th>Mode</th><th>Side</th><th>P&amp;L</th><th>Exit</th></tr></thead><tbody id="anaBestBody"></tbody></table></div></div>
        <div class="ana-mini"><h3>📅 Best Trading Days</h3><div style="overflow-x:auto;max-height:280px;overflow-y:auto;"><table class="ana-tbl"><thead><tr><th>Date</th><th>Trades</th><th>Day P&amp;L</th><th>Wins</th><th>Best</th></tr></thead><tbody id="anaBestDayBody"></tbody></table></div></div>
        <div class="ana-mini"><h3>⏰ Winning Hours</h3><div style="overflow-x:auto;"><table class="ana-tbl"><thead><tr><th>Hour</th><th>Wins</th><th>Win P&amp;L</th><th>Avg Win</th><th>Win%</th></tr></thead><tbody id="anaWinHourBody"></tbody></table></div></div>
      </div>

      <!-- Cross-mode comparison charts -->
      <div class="ana-section-title cross">🧭 Cross-Mode Detail</div>
      <div class="ana-row">
        <div class="ana-card"><h3>📈 Cumulative P&amp;L by Mode</h3><div class="ana-chart-wrap"><canvas id="anaCumByMode"></canvas></div></div>
        <div class="ana-card"><h3>📊 Monthly P&amp;L (stacked by mode)</h3><div class="ana-chart-wrap"><canvas id="anaMonthlyStacked"></canvas></div></div>
      </div>
      <div class="ana-row">
        <div class="ana-card"><h3>📊 P&amp;L Distribution (all trades)</h3><div class="ana-chart-wrap"><canvas id="anaPnlDist"></canvas></div></div>
        <div class="ana-card"><h3>📈 Rolling 30-trade Win Rate</h3><div class="ana-chart-wrap"><canvas id="anaRollWr"></canvas></div></div>
      </div>

      <!-- Time / duration / spot analytics -->
      <div class="ana-section-title" style="color:#60a5fa;">⏱ Time &amp; Spot Analytics</div>
      <div class="ana-row">
        <div class="ana-card"><h3>⏱ Trade Duration Distribution (minutes)</h3><div class="ana-chart-wrap"><canvas id="anaDurDist"></canvas></div></div>
        <div class="ana-card"><h3>🎯 NIFTY Spot Move Distribution (points)</h3><div class="ana-chart-wrap"><canvas id="anaSpotMove"></canvas></div></div>
      </div>
      <div class="ana-row">
        <div class="ana-mini"><h3>⏱ Duration vs P&amp;L (buckets)</h3><div style="overflow-x:auto;"><table class="ana-tbl"><thead><tr><th>Bucket</th><th>Trades</th><th>Wins</th><th>WR%</th><th>P&amp;L</th><th>Avg</th></tr></thead><tbody id="anaDurBody"></tbody></table></div></div>
        <div class="ana-mini"><h3>🗓 Day × Hour Heatmap (Net P&amp;L)</h3><div id="anaHeatmap" style="font-family:'IBM Plex Mono',monospace;font-size:0.62rem;"></div></div>
      </div>

      <!-- Weekly + drawdown stats -->
      <div class="ana-row">
        <div class="ana-mini"><h3>📅 Weekly Performance</h3><div style="overflow-x:auto;max-height:320px;overflow-y:auto;"><table class="ana-tbl"><thead><tr><th>Week</th><th>Trades</th><th>Wins</th><th>WR%</th><th>P&amp;L</th><th>Avg</th></tr></thead><tbody id="anaWeeklyBody"></tbody></table></div></div>
        <div class="ana-mini"><h3>📉 Drawdown Stats</h3><div id="anaDdStats"></div></div>
      </div>

      <!-- Strike / expiry / symbol concentration -->
      <div class="ana-section-title" style="color:#f59e0b;">🎯 Contract Analytics</div>
      <div class="ana-row3">
        <div class="ana-mini"><h3>🏷 Top Option Symbols</h3><div style="overflow-x:auto;max-height:280px;overflow-y:auto;"><table class="ana-tbl"><thead><tr><th>Symbol</th><th>Trades</th><th>WR%</th><th>P&amp;L</th></tr></thead><tbody id="anaSymBody"></tbody></table></div></div>
        <div class="ana-mini"><h3>🎯 Strike Analysis</h3><div style="overflow-x:auto;max-height:280px;overflow-y:auto;"><table class="ana-tbl"><thead><tr><th>Strike</th><th>Trades</th><th>WR%</th><th>P&amp;L</th></tr></thead><tbody id="anaStrikeBody"></tbody></table></div></div>
        <div class="ana-mini"><h3>📅 Expiry Analysis</h3><div style="overflow-x:auto;max-height:280px;overflow-y:auto;"><table class="ana-tbl"><thead><tr><th>Expiry</th><th>Trades</th><th>WR%</th><th>P&amp;L</th></tr></thead><tbody id="anaExpiryBody"></tbody></table></div></div>
      </div>
      <div class="ana-row">
        <div class="ana-mini"><h3>🧬 Strategy Variant Breakdown</h3><div style="overflow-x:auto;max-height:280px;overflow-y:auto;"><table class="ana-tbl"><thead><tr><th>Strategy</th><th>Mode</th><th>Trades</th><th>WR%</th><th>P&amp;L</th><th>Avg</th></tr></thead><tbody id="anaStratBody"></tbody></table></div></div>
        <div class="ana-mini"><h3>🔢 Quantity Buckets</h3><div style="overflow-x:auto;"><table class="ana-tbl"><thead><tr><th>Qty</th><th>Trades</th><th>WR%</th><th>P&amp;L</th><th>Avg</th></tr></thead><tbody id="anaQtyBody"></tbody></table></div></div>
      </div>
    </div>

    <!-- Analytics -->
    <div class="panel">
      <h3>Cumulative P&amp;L</h3>
      <div class="chart-wrap"><canvas id="cumChart"></canvas></div>
    </div>

    <div class="panel">
      <h3>Daily P&amp;L</h3>
      <div class="chart-wrap"><canvas id="dailyChart"></canvas></div>
    </div>

    <div class="roll-grid">
      <div class="panel">
        <h3>Daily Roll-up</h3>
        <div class="tbl-wrap" style="max-height:300px;">
          <table class="tbl" id="dailyTbl">
            <thead><tr>
              <th class="sortable" data-key="key">Date</th>
              <th class="sortable num" data-key="count">Trades</th>
              <th class="sortable num" data-key="pnl">P&amp;L</th>
              <th></th>
            </tr></thead>
            <tbody></tbody>
          </table>
        </div>
        <div class="pager" data-for="dailyTbl">
          <label>Rows</label>
          <select class="pager-size">
            <option value="5">5</option><option value="10" selected>10</option><option value="25">25</option><option value="50">50</option><option value="0">All</option>
          </select>
          <span class="pager-info"></span>
          <button class="btn pager-btn" data-action="first" title="First">«</button>
          <button class="btn pager-btn" data-action="prev"  title="Prev">‹</button>
          <button class="btn pager-btn" data-action="next"  title="Next">›</button>
          <button class="btn pager-btn" data-action="last"  title="Last">»</button>
        </div>
      </div>
      <div class="panel">
        <h3>Monthly Roll-up</h3>
        <div class="tbl-wrap" style="max-height:300px;">
          <table class="tbl" id="monthlyTbl">
            <thead><tr>
              <th class="sortable" data-key="key">Month</th>
              <th class="sortable num" data-key="count">Trades</th>
              <th class="sortable num" data-key="pnl">P&amp;L</th>
              <th></th>
            </tr></thead>
            <tbody></tbody>
          </table>
        </div>
        <div class="pager" data-for="monthlyTbl">
          <label>Rows</label>
          <select class="pager-size">
            <option value="5">5</option><option value="10" selected>10</option><option value="25">25</option><option value="50">50</option><option value="0">All</option>
          </select>
          <span class="pager-info"></span>
          <button class="btn pager-btn" data-action="first" title="First">«</button>
          <button class="btn pager-btn" data-action="prev"  title="Prev">‹</button>
          <button class="btn pager-btn" data-action="next"  title="Next">›</button>
          <button class="btn pager-btn" data-action="last"  title="Last">»</button>
        </div>
      </div>
      <div class="panel">
        <h3>Yearly Roll-up</h3>
        <div class="tbl-wrap" style="max-height:300px;">
          <table class="tbl" id="yearlyTbl">
            <thead><tr>
              <th class="sortable" data-key="key">Year</th>
              <th class="sortable num" data-key="count">Trades</th>
              <th class="sortable num" data-key="pnl">P&amp;L</th>
              <th></th>
            </tr></thead>
            <tbody></tbody>
          </table>
        </div>
        <div class="pager" data-for="yearlyTbl">
          <label>Rows</label>
          <select class="pager-size">
            <option value="5">5</option><option value="10" selected>10</option><option value="25">25</option><option value="50">50</option><option value="0">All</option>
          </select>
          <span class="pager-info"></span>
          <button class="btn pager-btn" data-action="first" title="First">«</button>
          <button class="btn pager-btn" data-action="prev"  title="Prev">‹</button>
          <button class="btn pager-btn" data-action="next"  title="Next">›</button>
          <button class="btn pager-btn" data-action="last"  title="Last">»</button>
        </div>
      </div>
    </div>

    <div class="panel">
      <h3>All Trades (Filtered)</h3>
      <div class="tbl-wrap">
        <table class="tbl" id="tradesTbl">
          <thead><tr>
            <th>#</th>
            <th class="sortable" data-key="mode">Strategy</th>
            <th class="sortable" data-key="market">Market</th>
            <th class="sortable" data-key="date">Date</th>
            <th class="sortable" data-key="side">Side</th>
            <th class="sortable" data-key="symbol">Symbol</th>
            <th class="sortable num" data-key="qty">Qty</th>
            <th class="sortable num" data-key="entryPrice">Entry</th>
            <th class="sortable num" data-key="exitPrice">Exit</th>
            <th class="sortable" data-key="entryTime">Entry Time</th>
            <th class="sortable" data-key="exitTime">Exit Time</th>
            <th class="sortable num" data-key="pnl">P&amp;L</th>
            <th class="sortable" data-key="exitReason">Exit Reason</th>
            <th class="sortable num" data-key="peBest" title="Spot points after exit, in the trade's direction (post-exit tracker)">After exit</th>
            <th>Copy</th>
          </tr></thead>
          <tbody></tbody>
        </table>
      </div>
      <div class="pager" data-for="tradesTbl">
        <label>Rows</label>
        <select class="pager-size">
          <option value="10">10</option><option value="25" selected>25</option><option value="50">50</option><option value="100">100</option><option value="0">All</option>
        </select>
        <span class="pager-info"></span>
        <button class="btn pager-btn" data-action="first" title="First">«</button>
        <button class="btn pager-btn" data-action="prev"  title="Prev">‹</button>
        <button class="btn pager-btn" data-action="next"  title="Next">›</button>
        <button class="btn pager-btn" data-action="last"  title="Last">»</button>
      </div>
      <div id="emptyState" class="empty" style="display:none;">No trades match your filters.</div>
    </div>

    <div class="panel">
      <h3>Daily export (CSV + summary)</h3>
      <div class="td-export-msg">Written automatically after 16:30 IST on trading days to ~/trading-data/exports/. Never runs 09:00–15:30 IST on a weekday.</div>
      <div class="td-export">
        <input type="date" id="expDate" aria-label="Export date"/>
        <button type="button" class="btn" id="expBtn" onclick="exportDay()">Write export</button>
        <span class="td-export-msg" id="expMsg"></span>
      </div>
    </div>
  </div>
</div>

<!-- Trade detail sheet: right panel on desktop, bottom sheet on a phone -->
<div class="td-backdrop" id="tdBackdrop" onclick="closeTrade()"></div>
<div class="td-sheet" id="tdSheet" role="dialog" aria-modal="true" aria-labelledby="tdTitle" aria-hidden="true">
  <div class="td-head">
    <div class="td-title" id="tdTitle">Trade</div>
    <button type="button" class="btn td-close" onclick="closeTrade()" aria-label="Close trade details">✕</button>
  </div>
  <div class="td-body" id="tdBody"></div>
</div>

<script>
${aiExportJS()}
${modalJS()}
${CC.clientScript()}
const TRADES = ${JSON.stringify(trades).replace(/</g, "\\u003c")};
// Modes TRADES holds, in page order: the strategies enabled in Settings, then
// any retired copy book with trades. The analytics sections enumerate this list
// rather than a fixed trio so a toggled-off strategy has no row, line or column,
// and a new one needs no edit.
const ENABLED_MODES = ${JSON.stringify(shownModes)};
const MODE_LABEL  = ${JSON.stringify(modeLabel).replace(/</g, "\\u003c")};
const STRAT_LABEL = ${JSON.stringify(stratLabel).replace(/</g, "\\u003c")};
const MARKET_LABEL = ${JSON.stringify(MARKET_LABEL)};
function mktLabel(m){ return MARKET_LABEL[m] || m || '—'; }
function stratLabel(id){ return STRAT_LABEL[id] || id || '—'; }

function fmtINR(n){
  if (typeof n !== 'number' || isNaN(n)) return '—';
  return '₹' + n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function pnlColor(n){ return (n >= 0) ? '#10b981' : '#ef4444'; }
function pnlRowBg(n){ return n > 0 ? 'rgba(16,185,129,0.07)' : (n < 0 ? 'rgba(239,68,68,0.07)' : 'transparent'); }

// Display formatter: convert any stored date/timestamp string into
// a UI-friendly form ("DD/MM/YYYY HH:MM" in IST when time present, else "DD/MM/YYYY").
// Pass-through for week/month/year rollup keys ("YYYY-Www", "YYYY-MM", "YYYY").
function fmtDateTime(s){
  if (s == null || s === '') return '—';
  const v = String(s);
  // ISO timestamp (YYYY-MM-DDT..)
  if (/^\\d{4}-\\d{2}-\\d{2}T/.test(v)){
    const d = new Date(v);
    if (isNaN(d)) return v;
    const ist = new Date(d.getTime() + 19800000);
    const dd = String(ist.getUTCDate()).padStart(2,'0');
    const mm = String(ist.getUTCMonth()+1).padStart(2,'0');
    const yyyy = ist.getUTCFullYear();
    const hh = String(ist.getUTCHours()).padStart(2,'0');
    const mi = String(ist.getUTCMinutes()).padStart(2,'0');
    return dd + '/' + mm + '/' + yyyy + ' ' + hh + ':' + mi;
  }
  // YYYY-MM-DD
  if (/^\\d{4}-\\d{2}-\\d{2}$/.test(v)){
    return v.slice(8,10) + '/' + v.slice(5,7) + '/' + v.slice(0,4);
  }
  // YYYY-MM (monthly key)
  if (/^\\d{4}-\\d{2}$/.test(v)){
    return v.slice(5,7) + '/' + v.slice(0,4);
  }
  // Trade entry/exit time: "DD/MM/YYYY, HH:MM:SS" → "DD/MM/YYYY HH:MM"
  const tm = v.match(/^(\\d{1,2})\\/(\\d{1,2})\\/(\\d{4})[,\\s]+(\\d{1,2}):(\\d{2})/);
  if (tm){
    return \`\${tm[1].padStart(2,'0')}/\${tm[2].padStart(2,'0')}/\${tm[3]} \${tm[4].padStart(2,'0')}:\${tm[5]}\`;
  }
  // YYYY-Www, YYYY, anything else — leave as-is
  return v;
}

// Parse entry/exit times. istNow() writes "DD/MM/YYYY, HH:MM:SS"; older records use
// "HH:MM, DD/MM/YYYY". Match the date and clock halves independently so field order
// doesn't matter — the date half has no colon and the clock half has no slash.
function parseEntryTime(t){
  if (!t) return null;
  const s = String(t);
  const d = s.match(/(\\d{1,2})\\/(\\d{1,2})\\/(\\d{4})/);
  const c = s.match(/(\\d{1,2}):(\\d{2})/);
  if (!d || !c) return null;
  return new Date(+d[3], +d[2]-1, +d[1], +c[1], +c[2]);
}

// ── Filter state ⇄ form ⇄ URL ────────────────────────────────────────────────
// The form is the editor; the URL query is the record (CC.toQuery), so a
// bookmarked or shared link reopens the exact same view. ?mode= (one exact
// book, e.g. a retired BN_* copy) has no control of its own but is honoured.
const F_FIELDS = { market: 'fMarket', strategy: 'fStrat', preset: 'fPreset', from: 'fFrom', to: 'fTo',
                   side: 'fSide', result: 'fResult', exit: 'fExit', expiry: 'fExpiry', q: 'fSearch' };
let _modeParam = '';
function getState(){
  const f = CC.emptyFilter();
  for (const k in F_FIELDS){ const el = document.getElementById(F_FIELDS[k]); f[k] = el ? String(el.value || '').trim() : ''; }
  f.mode = _modeParam;
  if (!f.preset) f.preset = 'all';
  if (f.preset !== 'custom'){ f.from = ''; f.to = ''; }
  return f;
}
function setState(f){
  for (const k in F_FIELDS){
    const el = document.getElementById(F_FIELDS[k]);
    if (!el) continue;
    const v = f[k] || (k === 'preset' ? 'all' : '');
    // A bookmarked value the dropdown no longer lists (a market with no trades
    // yet) is still honoured — add it rather than silently widening the view.
    if (el.tagName === 'SELECT' && v && !Array.from(el.options).some(o => o.value === v)){
      const o = document.createElement('option'); o.value = v; o.textContent = v; el.appendChild(o);
    }
    el.value = v;
  }
  _modeParam = f.mode || '';
  syncCustomVisibility();
}
function syncCustomVisibility(){
  const custom = document.getElementById('fPreset').value === 'custom';
  document.querySelectorAll('.fcustom').forEach(el => { el.style.display = custom ? '' : 'none'; });
}
function activeFilterCount(f){
  let n = 0;
  ['market','strategy','mode','side','result','exit','expiry','q'].forEach(k => { if (f[k]) n++; });
  if (f.preset && f.preset !== 'all') n++;
  return n;
}

function filterTrades(){
  return CC.filterTrades(TRADES, getState(), CC.istToday());
}

function weekKey(dateStr){
  // ISO week: YYYY-Www (Monday-start). dateStr is "YYYY-MM-DD".
  if (!dateStr) return '';
  const d = new Date(dateStr + 'T00:00:00');
  if (isNaN(d)) return '';
  const tmp = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = tmp.getUTCDay() || 7;
  tmp.setUTCDate(tmp.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((tmp - yearStart) / 86400000) + 1) / 7);
  return tmp.getUTCFullYear() + '-W' + String(weekNo).padStart(2, '0');
}
function monthKey(d){ return (d || '').slice(0, 7);  } // YYYY-MM
function yearKey(d) { return (d || '').slice(0, 4);  } // YYYY

function rollup(trades, keyFn){
  const out = new Map();
  for (const t of trades){
    const k = keyFn(t.date);
    if (!k) continue;
    if (!out.has(k)) out.set(k, { key: k, count: 0, pnl: 0, trades: [] });
    const b = out.get(k);
    b.count++;
    b.pnl += t.pnl;
    b.trades.push(t);
  }
  return Array.from(out.values()).sort((a, b) => b.key.localeCompare(a.key));
}

// ── Sort + pagination state ──────────────────────────────────────────────────
const TBL_STATE = {
  dailyTbl:   { sortKey: 'key',  sortDir: 'desc', page: 1, pageSize: 10, totalPages: 1 },
  monthlyTbl: { sortKey: 'key',  sortDir: 'desc', page: 1, pageSize: 10, totalPages: 1 },
  yearlyTbl:  { sortKey: 'key',  sortDir: 'desc', page: 1, pageSize: 10, totalPages: 1 },
  tradesTbl:  { sortKey: 'date', sortDir: 'desc', page: 1, pageSize: 25, totalPages: 1 },
};

// Rendered (sorted + sliced) arrays kept so copy buttons can map local index → row
const _rendered = { dailyTbl: [], monthlyTbl: [], yearlyTbl: [], tradesTbl: [] };

// Time-time like "HH:MM, DD/MM/YYYY" → numeric (ms) for sorting
function timeStrToNum(s){
  const d = parseEntryTime(s);
  return d ? d.getTime() : -Infinity;
}

function sortValue(row, key){
  if (key === 'entryTime' || key === 'exitTime') return timeStrToNum(row[key]);
  if (key === 'peBest') return row.postExit && row.postExit.bestPts != null ? row.postExit.bestPts : null;
  return row[key];
}

function cmpVals(a, b, dir){
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  let r;
  if (typeof a === 'number' && typeof b === 'number') r = a - b;
  else r = String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
  return dir === 'asc' ? r : -r;
}

function sortRows(rows, key, dir){
  return rows.slice().sort((a, b) => cmpVals(sortValue(a, key), sortValue(b, key), dir));
}

function paginate(rows, page, pageSize){
  if (!pageSize) return { slice: rows, page: 1, totalPages: 1 };
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  const p = Math.min(Math.max(1, page), totalPages);
  const start = (p - 1) * pageSize;
  return { slice: rows.slice(start, start + pageSize), page: p, totalPages };
}

function updatePagerUI(tableId, total, shown, page, totalPages){
  const pager = document.querySelector(\`.pager[data-for="\${tableId}"]\`);
  if (!pager) return;
  const info = pager.querySelector('.pager-info');
  const st = TBL_STATE[tableId];
  st.totalPages = totalPages;
  if (!total){
    info.textContent = '0 of 0';
  } else if (!st.pageSize){
    info.textContent = \`All \${total}\`;
  } else {
    const start = (page - 1) * st.pageSize + 1;
    const end = Math.min(total, start + shown - 1);
    info.textContent = \`\${start}–\${end} of \${total} · pg \${page}/\${totalPages}\`;
  }
  pager.querySelector('[data-action="first"]').disabled = (page <= 1);
  pager.querySelector('[data-action="prev"]').disabled  = (page <= 1);
  pager.querySelector('[data-action="next"]').disabled  = (page >= totalPages);
  pager.querySelector('[data-action="last"]').disabled  = (page >= totalPages);
}

function updateSortIndicators(tableId){
  const st = TBL_STATE[tableId];
  const ths = document.querySelectorAll(\`#\${tableId} thead th.sortable\`);
  ths.forEach(th => {
    th.classList.remove('sorted-asc', 'sorted-desc');
    if (th.dataset.key === st.sortKey){
      th.classList.add(st.sortDir === 'asc' ? 'sorted-asc' : 'sorted-desc');
    }
  });
}

function renderRollupTable(id, rows){
  const tb = document.querySelector('#' + id + ' tbody');
  updateSortIndicators(id);
  if (!rows.length){
    tb.innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--muted-1,#8ba1c2);padding:18px;">No data</td></tr>';
    _rendered[id] = [];
    updatePagerUI(id, 0, 0, 1, 1);
    return;
  }
  const st = TBL_STATE[id];
  const sorted = sortRows(rows, st.sortKey, st.sortDir);
  const pg = paginate(sorted, st.page, st.pageSize);
  st.page = pg.page;
  _rendered[id] = pg.slice;
  tb.innerHTML = pg.slice.map((r, i) => \`
    <tr style="background:\${pnlRowBg(r.pnl)};">
      <td style="font-weight:600;">\${fmtDateTime(r.key)}</td>
      <td class="num">\${r.count}</td>
      <td class="num \${pnlCls(r.pnl)}" style="font-weight:700;">\${r.pnl >= 0 ? '+' : ''}\${fmtINR(r.pnl)}</td>
      <td><button class="btn" onclick="copyBucket('\${id}', \${i})">📋</button></td>
    </tr>\`).join('');
  updatePagerUI(id, sorted.length, pg.slice.length, pg.page, pg.totalPages);
}

function renderTradesTable(rows){
  const tb = document.querySelector('#tradesTbl tbody');
  const empty = document.getElementById('emptyState');
  updateSortIndicators('tradesTbl');
  if (!rows.length){
    tb.innerHTML = '';
    empty.style.display = 'block';
    _rendered.tradesTbl = [];
    updatePagerUI('tradesTbl', 0, 0, 1, 1);
    return;
  }
  empty.style.display = 'none';
  const st = TBL_STATE.tradesTbl;
  const sorted = sortRows(rows, st.sortKey, st.sortDir);
  const pg = paginate(sorted, st.page, st.pageSize);
  st.page = pg.page;
  _rendered.tradesTbl = pg.slice;
  const startNo = st.pageSize ? (pg.page - 1) * st.pageSize : 0;
  // data-label feeds the phone card layout (each cell prints its own heading).
  tb.innerHTML = pg.slice.map((t, i) => \`
    <tr data-i="\${i}" style="background:\${pnlRowBg(t.pnl)};">
      <td data-label="#" class="c-no">\${startNo + i + 1}</td>
      <td data-label="Strategy" class="c-strat"><span class="badge-mode badge-\${esc(t.mode)}" title="\${esc(MODE_LABEL[t.mode] || t.mode)}">\${esc(stratLabel(t.strategyId))}</span>\${t.retired ? ' <span class="retired-tag" title="Retired copy book — kept for its history">retired</span>' : ''}</td>
      <td data-label="Market" class="c-mkt"><span class="mkt-pill">\${esc(mktLabel(t.market))}</span>\${t.isExpiry === true ? ' <span class="exp-tag" title="Expiry day">EXP</span>' : ''}</td>
      <td data-label="Date" class="c-date">\${fmtDateTime(t.date)}</td>
      <td data-label="Side" class="c-side"><span class="badge \${t.dir === 'SHORT' ? 'badge-pe' : 'badge-ce'}">\${esc(t.side) || '—'}</span></td>
      <td data-label="Symbol" class="c-sym" style="max-width:180px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="\${esc(t.symbol)}">\${esc(t.symbol) || '—'}</td>
      <td data-label="Qty" class="num">\${t.qty || '—'}</td>
      <td data-label="Entry" class="num">\${fmtINR(t.entryPrice)}</td>
      <td data-label="Exit" class="num">\${fmtINR(t.exitPrice)}</td>
      <td data-label="Entry time" style="font-size:0.65rem;">\${esc(fmtDateTime(t.entryTime))}</td>
      <td data-label="Exit time" style="font-size:0.65rem;">\${esc(fmtDateTime(t.exitTime))}</td>
      <td data-label="P&amp;L" class="num c-pnl \${pnlCls(t.pnl)}" style="font-weight:700;">\${t.pnl >= 0 ? '+' : ''}\${fmtINR(t.pnl)}\${t.charges != null ? '<div class="sub-num">chg ' + fmtINR(t.charges) + '</div>' : ''}</td>
      <td data-label="Exit reason" class="c-reason" style="max-width:160px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:0.65rem;" title="\${esc(t.exitReason)}">\${esc(t.exitReason) || '—'}</td>
      <td data-label="After exit" class="num c-pe">\${postExitHtml(t.postExit)}</td>
      <td data-label="" class="c-copy"><div class="td-btns"><button class="btn" onclick="openTrade(\${i})" aria-label="Trade details">🔍</button><button class="btn" onclick="copyOne(\${i})" aria-label="Copy trade">📋</button></div></td>
    </tr>\`).join('');
  updatePagerUI('tradesTbl', sorted.length, pg.slice.length, pg.page, pg.totalPages);
}

function esc(s){
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

// ── Post-exit cell: best / worst spot move after the exit (points) ──────────
function fmtPts(v){ if (v == null || isNaN(v)) return '—'; const n = Number(v); return (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n).toFixed(1); }
function postExitHtml(pe){
  if (!pe) return '<span class="muted">—</span>';
  const best = pe.bestPts != null
    ? '<div class="pe-best" title="Best move in the trade direction after exit' + (pe.bestTime ? ' (at ' + esc(pe.bestTime) + ')' : '') + '">▲ ' + fmtPts(pe.bestPts)
      + (pe.minsToBest != null ? ' <span class="sub-num">' + pe.minsToBest + 'm</span>' : '') + '</div>' : '';
  const worst = pe.worstPts != null
    ? '<div class="pe-worst" title="Worst move against the trade after exit' + (pe.worstTime ? ' (at ' + esc(pe.worstTime) + ')' : '') + '">▼ ' + fmtPts(pe.worstPts) + '</div>' : '';
  return best + worst || '<span class="muted">—</span>';
}

// ── Totals, breakdowns ──────────────────────────────────────────────────────
function fmtSigned(n){ return (n >= 0 ? '+' : '') + fmtINR(n); }
function fmtPF(pf){ return pf == null ? '—' : (pf === Infinity ? '∞' : pf.toFixed(2)); }
// 'pos' / 'neg' classes, not inline colours: the light theme forces stat and
// cell text colours with !important, which an inline colour cannot beat.
function pnlCls(n){ return n > 0 ? 'pos' : (n < 0 ? 'neg' : ''); }
function tile(label, val, sub, cls, accent){
  return '<div class="sc" style="--accent:' + (accent || '#3b82f6') + ';"><div class="sc-label">' + label + '</div>'
    + '<div class="sc-val num ' + (cls || '') + '">' + val + '</div>'
    + (sub ? '<div class="sc-sub">' + sub + '</div>' : '') + '</div>';
}
function renderTotals(rows){
  const o = CC.totals(rows);
  const el = document.getElementById('totGrid');
  if (!rows.length){
    el.innerHTML = '<div class="sc tot-empty" style="--accent:#4a6080;"><div class="sc-label">No trades</div><div class="sc-sub">Nothing matches these filters.</div></div>';
    return;
  }
  const chgSub = o.chargesN === o.trades ? 'on every trade' : (o.chargesN ? 'recorded on ' + o.chargesN + ' of ' + o.trades : 'not recorded');
  el.innerHTML = [
    tile('Net P&amp;L', fmtSigned(o.net), o.wins + 'W / ' + o.losses + 'L' + (o.flats ? ' / ' + o.flats + ' flat' : ''), pnlCls(o.net), o.net >= 0 ? '#10b981' : '#ef4444'),
    tile('Gross P&amp;L', fmtSigned(o.gross), 'before charges', pnlCls(o.gross), '#38bdf8'),
    tile('Charges', o.chargesN ? fmtINR(o.charges) : '—', chgSub, null, '#f59e0b'),
    tile('Trades', String(o.trades), 'expectancy ' + fmtSigned(o.expectancy), null, '#3b82f6'),
    tile('Win rate', o.winRate.toFixed(1) + '%', o.wins + ' of ' + o.trades, o.winRate >= 50 ? 'pos' : 'neg', '#a855f7'),
    tile('Avg win / loss', o.wins ? '+' + fmtINR(o.avgWin) : '—', 'loss ' + (o.losses ? fmtINR(o.avgLoss) : '—'), o.wins ? 'pos' : null, '#14b8a6'),
    tile('Profit factor', fmtPF(o.pf), 'gross win ÷ gross loss', o.pf == null ? null : (o.pf >= 1 ? 'pos' : 'neg'), '#e879f9'),
    tile('Max drawdown', o.maxDD ? '−' + fmtINR(o.maxDD) : fmtINR(0), o.maxDD ? fmtDateTime(o.ddPeakDate || o.ddTroughDate) + ' → ' + fmtDateTime(o.ddTroughDate) : 'no drawdown', o.maxDD ? 'neg' : null, '#ef4444'),
  ].join('');
}
function renderBreakdown(tableId, rows, keyFn, labelFn){
  const tb = document.querySelector('#' + tableId + ' tbody');
  const list = CC.breakdown(rows, keyFn);
  if (!list.length){ tb.innerHTML = '<tr><td colspan="6" class="empty-cell">No data</td></tr>'; return; }
  tb.innerHTML = list.map(r =>
    '<tr><td data-label="" class="bd-key">' + esc(labelFn(r.key)) + '</td>'
    + '<td data-label="Trades" class="num">' + r.trades + '</td>'
    + '<td data-label="WR" class="num">' + r.winRate.toFixed(0) + '%</td>'
    + '<td data-label="Net" class="num ' + pnlCls(r.net) + '" style="font-weight:700;">' + fmtSigned(r.net) + '</td>'
    + '<td data-label="PF" class="num">' + fmtPF(r.pf) + '</td>'
    + '<td data-label="Max DD" class="num ' + (r.maxDD ? 'neg' : '') + '">' + (r.maxDD ? '−' + fmtINR(r.maxDD) : '—') + '</td></tr>'
  ).join('');
}

// ── Mobile filter sheet ─────────────────────────────────────────────────────
function openSheet(){
  document.body.classList.add('fsheet-on');
  document.getElementById('fSheetOpen').setAttribute('aria-expanded', 'true');
  const first = document.getElementById('fMarket'); if (first) first.focus({ preventScroll: true });
}
function closeSheet(){
  document.body.classList.remove('fsheet-on');
  document.getElementById('fSheetOpen').setAttribute('aria-expanded', 'false');
}
document.addEventListener('keydown', e => { if (e.key === 'Escape' && document.body.classList.contains('fsheet-on')) closeSheet(); });

function tradeToLine(t){
  return [
    t.date, t.mode, t.market || '—', t.side, t.symbol || '—',
    'qty=' + (t.qty || 0),
    'entry=' + (t.entryPrice ?? '—'),
    'exit='  + (t.exitPrice ?? '—'),
    'entryTime=' + (t.entryTime || '—'),
    'exitTime='  + (t.exitTime || '—'),
    'pnl=' + (typeof t.pnl === 'number' ? t.pnl.toFixed(2) : '—'),
    'reason=' + (t.exitReason || '—'),
  ].join(' | ');
}

function tradesToText(list, header){
  const totalPnl = list.reduce((a, t) => a + (t.pnl || 0), 0);
  const w = list.filter(t => t.pnl > 0).length;
  const l = list.filter(t => t.pnl < 0).length;
  const head = header ? header + '\\n' : '';
  const summary = \`-- \${list.length} trades | \${w}W/\${l}L | Total P&L: \${totalPnl >= 0 ? '+' : ''}\${totalPnl.toFixed(2)} --\\n\`;
  return head + summary + list.map(tradeToLine).join('\\n');
}

function tradesToCSV(list){
  const cols = ['date','mode','market','strategyId','side','symbol','qty','entryPrice','exitPrice','spotAtEntry','spotAtExit','optionEntryLtp','optionExitLtp','entryTime','exitTime','pnl','gross','charges','pnlMode','entryReason','exitReason','exitCat','isExpiry','optionStrike','optionType','optionExpiry','strategy','instrument','isFutures',
                'peBestPts','peBestTime','peMinsToBest','peWorstPts','peWorstTime'];
  const PE = { peBestPts: 'bestPts', peBestTime: 'bestTime', peMinsToBest: 'minsToBest', peWorstPts: 'worstPts', peWorstTime: 'worstTime' };
  list = list.map(t => { if (!t.postExit) return t; const o = Object.assign({}, t); for (const k in PE) o[k] = t.postExit[PE[k]]; return o; });
  const esc = v => {
    if (v == null) return '';
    const s = String(v);
    return /[,"\\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const header = cols.join(',');
  const body = list.map(t => cols.map(c => esc(t[c])).join(',')).join('\\n');
  return header + '\\n' + body;
}

async function copyText(text, btn){
  try {
    await navigator.clipboard.writeText(text);
    if (btn){
      const orig = btn.textContent;
      btn.classList.add('copied');
      btn.textContent = '✓ Copied';
      setTimeout(() => { btn.classList.remove('copied'); btn.textContent = orig; }, 1400);
    }
  } catch(e) {
    alert('Copy failed: ' + e.message);
  }
}

let _lastFiltered = [];
let _lastRollups  = { daily: [], weekly: [], monthly: [], yearly: [] };

function copyOne(idx){
  const t = _rendered.tradesTbl[idx];
  if (!t) return;
  copyText(tradesToText([t], '# Trade'), event.target);
}

// ── Trade detail sheet (tap a trade) ────────────────────────────────────────
// Row fields render at once; the trade journal (utils/tradeJournal) is fetched
// by id. Trades from before journals (or from a route not hooked yet) show
// "not recorded" for the journal parts.
let _tdSeq = 0;
function tdNum(v, d){ if (v == null || v === '' || isNaN(v)) return null; return Number(v).toFixed(d == null ? 2 : d); }
function tdRs(v){ return (v == null || v === '' || isNaN(v)) ? null : fmtINR(Number(v)); }
function tdP(v){ return (v == null || v === '' || isNaN(v)) ? null : fmtPts(v) + ' pts'; }
function tdAt(ist, mins){ if (!ist) return null; return esc(ist) + (mins != null ? ' <span class="sub-num">(+' + esc(mins) + ' min)</span>' : ''); }
function tdNR(what){ return '<div class="td-nr">' + esc(what) + ' — not recorded</div>'; }
function tdSec(title, body){ return '<div class="td-sec"><h4>' + esc(title) + '</h4>' + body + '</div>'; }
function tdKv(pairs){
  let h = '';
  pairs.forEach(function(p){ if (p[1] == null || p[1] === '') return; h += '<div><span>' + esc(p[0]) + '</span><span>' + p[1] + '</span></div>'; });
  return h ? '<div class="td-kv">' + h + '</div>' : '';
}
function tdObj(o){
  if (!o || typeof o !== 'object') return '';
  return tdKv(Object.keys(o).slice(0, 40).map(function(k){
    const v = o[k];
    return [k, esc(v != null && typeof v === 'object' ? JSON.stringify(v) : v)];
  }));
}
function tdSpark(vals, label){
  const pts = (vals || []).filter(function(v){ return v != null && !isNaN(v); }).map(Number);
  if (pts.length < 2) return '';
  let lo = Math.min.apply(null, pts.concat([0])), hi = Math.max.apply(null, pts.concat([0]));
  if (hi === lo) hi = lo + 1;
  const W = 300, H = 60, y = function(v){ return (H - 4 - (v - lo) / (hi - lo) * (H - 8)).toFixed(1); };
  const line = pts.map(function(v, i){ return (i / (pts.length - 1) * W).toFixed(1) + ',' + y(v); }).join(' ');
  return '<svg class="td-spark" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" role="img" aria-label="' + esc(label) + '">'
    + '<line x1="0" x2="' + W + '" y1="' + y(0) + '" y2="' + y(0) + '" stroke="#4a6080" stroke-dasharray="3 3" stroke-width="1"/>'
    + '<polyline fill="none" stroke="#3b82f6" stroke-width="1.6" points="' + line + '"/></svg>';
}
function tdCandles(list, label){
  if (!list || !list.length) return '';
  const rows = list.map(function(c){
    return '<li><b>' + esc(c.t || '—') + '</b> O ' + esc(tdNum(c.o) || '—') + ' H ' + esc(tdNum(c.h) || '—') + ' L ' + esc(tdNum(c.l) || '—') + ' C ' + esc(tdNum(c.c) || '—')
      + (c.v != null ? ' V ' + esc(c.v) : '') + (c.ind ? ' <span class="sub-num">' + esc(JSON.stringify(c.ind)) + '</span>' : '') + '</li>';
  }).join('');
  return '<details><summary class="td-nr" style="cursor:pointer;min-height:32px;">' + esc(label) + ' (' + list.length + ')</summary><ul class="td-tl">' + rows + '</ul></details>';
}
function tdStops(j){
  if (!j.stops || !j.stops.length) return '<div class="td-nr">No stop / trail changes were recorded for this trade.</div>';
  const items = j.stops.map(function(s){
    const mv = (s.from != null ? esc(s.from) + ' → ' : '') + '<b>' + esc(s.to != null ? s.to : 'removed') + '</b>';
    return '<li class="k-' + esc(s.kind) + '"><b>#' + esc(s.n) + ' ' + esc(s.kind) + '</b> ' + mv + ' · ' + (tdAt(s.ist, s.minFromEntry) || '')
      + (s.reason ? '<div>' + esc(s.reason) + '</div>' : '')
      + '<div class="sub-num">' + [s.favPts != null ? 'trade then ' + fmtPts(s.favPts) + ' pts' : '', s.peakPts != null ? 'peak so far ' + fmtPts(s.peakPts) + ' pts' : '',
         s.spot != null ? 'spot ' + esc(s.spot) : '', s.ltp != null ? 'LTP ' + esc(s.ltp) : ''].filter(Boolean).join(' · ') + '</div></li>';
  }).join('');
  return (j.stopsDropped ? '<div class="td-nr">' + esc(j.stopsDropped) + ' earlier move(s) not kept (list capped).</div>' : '') + '<ul class="td-tl">' + items + '</ul>';
}
function tdBars(j){
  const bars = j.bars || [];
  if (!bars.length) return '<div class="td-nr">No minute rows were recorded.</div>';
  const rows = bars.map(function(b){
    return '<li><b>' + esc(b.t) + '</b>' + (b.partial ? ' (partial)' : '') + ' spot ' + esc(b.s ? b.s[3] : '—') + (b.o ? ' · opt ' + esc(b.o[3]) : '')
      + (b.pnl != null ? ' · ' + fmtINR(b.pnl) : '') + (b.sl != null ? ' · SL ' + esc(b.sl) : '') + (b.tg != null ? ' · TG ' + esc(b.tg) : '') + '</li>';
  }).join('');
  return tdSpark(bars.map(function(b){ return b.pnl; }), 'Unrealised P&L by minute')
    + '<div class="td-nr">' + bars.length + ' minute row(s) from ' + esc(j.barSource || '—') + (j.barsDropped ? ' · ' + esc(j.barsDropped) + ' middle row(s) dropped (cap)' : '') + '</div>'
    + '<details><summary class="td-nr" style="cursor:pointer;min-height:32px;">Show minute rows</summary><ul class="td-tl">' + rows + '</ul></details>';
}
function tdPostExit(t, pe){
  if (pe && (pe.bestAfterExit || pe.worstAfterExit)) {
    const b = pe.bestAfterExit || {}, w = pe.worstAfterExit || {}, l = pe.lastBeforeClose || {};
    const mk = function(k){ return pe[k] ? fmtPts(pe[k].pts) + ' pts' : null; };
    return tdKv([['Best after exit', b.pts != null ? fmtPts(b.pts) + ' pts at ' + esc(b.time || '—') + (b.minutesAfterExit != null ? ' (+' + esc(b.minutesAfterExit) + ' min)' : '') : null],
                 ['Worst after exit', w.pts != null ? fmtPts(w.pts) + ' pts at ' + esc(w.time || '—') : null],
                 ['+5 min', mk('plus5m')], ['+15 min', mk('plus15m')], ['+30 min', mk('plus30m')], ['+60 min', mk('plus60m')],
                 ['Last before close', l.pts != null ? fmtPts(l.pts) + ' pts at ' + esc(l.time || '—') : null],
                 ['Restarts while watching', pe.restarts ? esc(pe.restarts) + ' (~' + esc(pe.downtimeMin) + ' min unwatched)' : null]]);
  }
  const p = t.postExit;
  if (p) return tdKv([['Best after exit', p.bestPts != null ? fmtPts(p.bestPts) + ' pts' + (p.bestTime ? ' at ' + esc(p.bestTime) : '') : null],
                      ['Worst after exit', p.worstPts != null ? fmtPts(p.worstPts) + ' pts' : null],
                      ['+5 / +15 / +30 / +60 min', [p.p5, p.p15, p.p30, p.p60].map(fmtPts).join(' / ')]]);
  return tdNR('Post-exit move');
}
function renderTrade(t, j, pe, loading){
  document.getElementById('tdTitle').textContent = [stratLabel(t.strategyId), mktLabel(t.market), t.side, t.symbol].filter(Boolean).join(' · ');
  const e = j && j.entry, x = j && j.exit;
  let h = tdSec('Trade', tdKv([['Date', esc(t.date)], ['Qty', esc(t.qty || '—')], ['Entry', esc(fmtDateTime(t.entryTime)) + ' @ ' + fmtINR(t.entryPrice)],
    ['Exit', esc(fmtDateTime(t.exitTime)) + ' @ ' + fmtINR(t.exitPrice)], ['P&L', '<span class="' + pnlCls(t.pnl) + '">' + fmtSigned(t.pnl) + '</span>'],
    ['Charges', tdRs(t.charges)]]));
  const nr = loading ? function(w){ return '<div class="td-nr">' + esc(w) + ' — loading…</div>'; } : tdNR;
  h += tdSec('Entry — why', '<div class="td-why">' + esc((e && e.reason) || t.entryReason || '—') + '</div>'
    + (e ? tdKv([['Time (IST)', esc(e.ist)], ['Spot', esc(tdNum(e.spot))], ['Option LTP', esc(tdNum(e.optionLtp))],
        ['Bid / Ask', e.bid != null || e.ask != null ? esc(tdNum(e.bid) || '—') + ' / ' + esc(tdNum(e.ask) || '—') : null],
        ['Spread', e.spread != null ? esc(tdNum(e.spread)) + ' (' + esc(tdNum(e.spreadPct)) + '%)' : null], ['VIX', esc(tdNum(e.vix))],
        ['Expiry', e.expiry ? esc(e.expiry) + (e.dte != null ? ' (' + esc(e.dte) + ' DTE)' : '') : null], ['Initial SL', esc(e.sl)], ['Target', esc(e.target)],
        ['Wanted / filled', e.expectedPrice != null ? esc(tdNum(e.expectedPrice)) + ' / ' + esc(tdNum(e.fill)) : null], ['Entry slippage', tdP(e.slippagePts)]])
      + (e.indicators ? '<h4 style="margin-top:8px;">Indicators</h4>' + tdObj(e.indicators) : '')
      + (e.signal && typeof e.signal === 'object' ? '<h4 style="margin-top:8px;">Signal</h4>' + tdObj(e.signal) : '')
      + tdCandles(e.candles, 'Spot candles before entry') + tdCandles(e.optionCandles, 'Option candles before entry')
      : nr('Entry snapshot')));
  h += tdSec('Peak profit & drawdown', j ? tdKv([
      ['Peak', j.peak ? tdP(j.peak.pts) + (j.peak.rs != null ? ' · ' + fmtINR(j.peak.rs) : '') + ' at ' + tdAt(j.peak.ist, j.peak.minFromEntry) : null],
      ['Peak ₹', j.peakRs && (!j.peak || j.peakRs.ms !== j.peak.ms) ? fmtINR(j.peakRs.rs) + ' at ' + tdAt(j.peakRs.ist, j.peakRs.minFromEntry) : null],
      ['Worst', j.worst ? tdP(j.worst.pts) + (j.worst.rs != null ? ' · ' + fmtINR(j.worst.rs) : '') + ' at ' + tdAt(j.worst.ist, j.worst.minFromEntry) : null],
      ['First move', j.path && j.path.firstMoveDir ? esc(j.path.firstMoveDir) + ' after ' + esc(j.path.secsToFirstMove) + ' s' : null],
      ['Ticks seen', esc(j.ticks)]]) + tdSpark(j.path && j.path.pathPts, 'Favourable points every 30 s')
    : nr('Peak and drawdown'));
  h += tdSec('Stop / trail timeline', j ? tdStops(j) : nr('Stop history'));
  h += tdSec('Minute path', j ? tdBars(j) : nr('Minute path'));
  h += tdSec('Exit — why', '<div class="td-why">' + esc((x && x.reason) || t.exitReason || '—') + '</div>'
    + (x ? tdKv([['Time (IST)', esc(x.ist)], ['Kind', esc(x.kind)], ['Spot', esc(tdNum(x.spot))], ['Option LTP', esc(tdNum(x.optionLtp))],
        ['Bid / Ask', x.bid != null || x.ask != null ? esc(tdNum(x.bid) || '—') + ' / ' + esc(tdNum(x.ask) || '—') : null],
        ['Wanted / filled', x.expectedPrice != null ? esc(tdNum(x.expectedPrice)) + ' / ' + esc(tdNum(x.fill)) : null],
        ['Slippage', x.slippagePts != null ? tdP(x.slippagePts) + (x.slippageRs != null ? ' · ' + fmtINR(x.slippageRs) : '') : null],
        ['Held', x.holdMin != null ? esc(x.holdMin) + ' min' + (x.candlesHeld != null ? ' · ' + esc(x.candlesHeld) + ' candles' : '') : null],
        ['Final stop', esc(x.finalStop)],
        ['Gave back from peak', x.givebackPts != null ? tdP(x.givebackPts) + (x.givebackRs != null ? ' · ' + fmtINR(x.givebackRs) : '') + (x.givebackPctOfPeak != null ? ' (' + esc(x.givebackPctOfPeak) + '% of peak)' : '') : 'never in profit']])
      + (x.indicators ? '<h4 style="margin-top:8px;">Indicators at exit</h4>' + tdObj(x.indicators) : '')
      + tdCandles(x.candles, 'Spot candles at exit') + tdCandles(x.optionCandles, 'Option candles at exit')
      : nr('Exit snapshot')));
  h += tdSec('After exit', tdPostExit(t, pe));
  document.getElementById('tdBody').innerHTML = h;
}
async function openTrade(idx){
  const t = _rendered.tradesTbl[idx];
  if (!t) return;
  const seq = ++_tdSeq;
  renderTrade(t, null, null, !!t.journalId);
  document.body.classList.add('td-on');
  document.getElementById('tdSheet').setAttribute('aria-hidden', 'false');
  if (!t.journalId) return;
  try {
    const r = await fetch('/consolidation/trade-detail?id=' + encodeURIComponent(t.journalId) + '&mode=' + encodeURIComponent(t.mode), { cache: 'no-store' });
    const d = await r.json();
    if (seq !== _tdSeq) return;
    renderTrade(t, d && d.journal, d && d.postExit, false);
  } catch (e) {
    if (seq === _tdSeq) renderTrade(t, null, null, false);
  }
}
function closeTrade(){
  _tdSeq++;
  document.body.classList.remove('td-on');
  document.getElementById('tdSheet').setAttribute('aria-hidden', 'true');
}
document.addEventListener('keydown', function(e){ if (e.key === 'Escape' && document.body.classList.contains('td-on')) closeTrade(); });
document.querySelector('#tradesTbl tbody').addEventListener('click', function(e){
  if (e.target.closest('button, a, summary')) return;
  const tr = e.target.closest('tr[data-i]');
  if (tr) openTrade(Number(tr.getAttribute('data-i')));
});

// ── Daily export on demand ──────────────────────────────────────────────────
(function(){ const el = document.getElementById('expDate'); if (el) el.value = new Date(Date.now() + 19800000).toISOString().slice(0, 10); })();
async function exportDay(){
  const msg = document.getElementById('expMsg');
  const date = document.getElementById('expDate').value;
  msg.textContent = 'Writing…';
  try {
    const r = await secretFetch('/consolidation/export-day', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ date: date }) });
    if (!r) { msg.textContent = 'Cancelled.'; return; }
    const d = await r.json();
    msg.textContent = d.success ? ('Wrote ' + d.csv + ' and ' + d.summary + ' (' + d.trades + ' trade(s), net ' + fmtSigned(d.net || 0) + ').') : ('Not written: ' + d.error);
  } catch (e) { msg.textContent = 'Export failed: ' + e.message; }
}

function copyBucket(tableId, idx){
  const list = _rendered[tableId] && _rendered[tableId][idx];
  if (!list) return;
  const header = \`# \${list.key} (\${list.count} trades)\`;
  copyText(tradesToText(list.trades, header), event.target);
}

function copyGroup(period){
  if (!_lastFiltered.length){ alert('No trades to copy — filters are empty.'); return; }
  let keyFn;
  if (period === 'daily')   keyFn = d => d;
  if (period === 'weekly')  keyFn = weekKey;
  if (period === 'monthly') keyFn = monthKey;
  if (period === 'yearly')  keyFn = yearKey;
  const buckets = rollup(_lastFiltered, keyFn);
  const chunks = buckets.map(b =>
    tradesToText(b.trades, \`# \${b.key} (\${b.count} trades, P&L: \${b.pnl >= 0 ? '+' : ''}\${b.pnl.toFixed(2)})\`)
  );
  copyText(chunks.join('\\n\\n'), event.target);
}

function copyAll(){
  if (!_lastFiltered.length){ alert('No trades to copy.'); return; }
  copyText(tradesToText(_lastFiltered, '# All filtered trades'), event.target);
}

function downloadCSV(){
  if (!_lastFiltered.length){ alert('No trades to export.'); return; }
  const csv = tradesToCSV(_lastFiltered);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'consolidation_' + new Date().toISOString().slice(0, 10) + '.csv';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function downloadAI(){
  if (!_lastFiltered.length){ alert('No trades to export.'); return; }
  const dates = _lastFiltered.map(t => t.date).filter(Boolean).sort();
  const range = dates.length ? dates[0] + ' → ' + dates[dates.length - 1] : '';
  downloadAiMarkdown(_lastFiltered,
    { title: 'Consolidation (filtered trades)', source: 'Consolidation (all paper modes)', range: range },
    'consolidation_' + new Date().toISOString().slice(0, 10) + '_AI');
}

let _cumChart = null;
function renderCumChart(rows){
  const ctx = document.getElementById('cumChart');
  if (!ctx) return;
  // Sort by (date, entryTime) ascending for a monotonic x-axis
  const sorted = rows.slice().sort((a, b) => {
    const da = (a.date || '') + ' ' + (a.entryTime || '');
    const db = (b.date || '') + ' ' + (b.entryTime || '');
    return da.localeCompare(db);
  });
  let cum = 0;
  const labels = [], data = [];
  for (const t of sorted){
    cum += (t.pnl || 0);
    labels.push(fmtDateTime(t.entryTime || t.date));
    data.push(cum);
  }
  const isLight = document.documentElement.getAttribute('data-theme') === 'light';
  const gridCol = isLight ? '#e0e4ea' : '#0e1e36';
  const tickCol = isLight ? '#64748b' : '#3a5070';
  const GREEN = '#10b981', RED = '#ef4444', FLAT = '#4a6080';
  const baseColor = cum > 0 ? GREEN : (cum < 0 ? RED : FLAT);
  const baseFill  = cum > 0 ? 'rgba(16,185,129,0.14)' : (cum < 0 ? 'rgba(239,68,68,0.14)' : 'rgba(74,96,128,0.10)');
  if (_cumChart) _cumChart.destroy();
  _cumChart = new Chart(ctx, {
    type: 'line',
    data: { labels, datasets: [{
      data, borderColor: baseColor, backgroundColor: baseFill,
      borderWidth: 2, fill: true, tension: 0.25, pointRadius: 0,
      segment: {
        borderColor: function(ctx){
          const y0 = ctx.p0.parsed.y, y1 = ctx.p1.parsed.y;
          return ((y0 + y1) / 2) >= 0 ? GREEN : RED;
        },
      },
    }]},
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { display: false },
        tooltip: { callbacks: { label: function(ctx){ return fmtINR(ctx.parsed.y); } } } },
      scales: {
        x: { ticks: { display: false }, grid: { display: false } },
        y: { ticks: { color: tickCol, font: { size: 10 }, callback: function(v){ return fmtINR(v); } }, grid: { color: gridCol } },
      },
    },
  });
}

let _dailyChart = null;
function renderDailyChart(){
  const ctx = document.getElementById('dailyChart');
  if (!ctx) return;
  // _lastRollups.daily is sorted desc by date; chart reads left→right oldest→newest
  const rows = (_lastRollups.daily || []).slice().sort((a, b) => a.key.localeCompare(b.key));
  const labels = rows.map(r => r.key);
  const data   = rows.map(r => r.pnl);
  const isLight = document.documentElement.getAttribute('data-theme') === 'light';
  const gridCol = isLight ? '#e0e4ea' : '#0e1e36';
  const tickCol = isLight ? '#64748b' : '#3a5070';
  const GREEN = '#10b981', RED = '#ef4444';
  const colors = data.map(v => v >= 0 ? GREEN : RED);
  if (_dailyChart) _dailyChart.destroy();
  _dailyChart = new Chart(ctx, {
    type: 'bar',
    data: { labels, datasets: [{ data, backgroundColor: colors, borderWidth: 0 }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false },
        tooltip: { callbacks: { title: function(c){ return c[0].label; }, label: function(ctx){ return fmtINR(ctx.parsed.y); } } } },
      scales: {
        x: { ticks: { color: tickCol, font: { size: 9 }, maxRotation: 45, autoSkip: true }, grid: { display: false } },
        y: { ticks: { color: tickCol, font: { size: 10 }, callback: function(v){ return fmtINR(v); } }, grid: { color: gridCol } },
      },
    },
  });
}

function applyFilters(){
  const f = getState();
  const rows = filterTrades();
  _lastFiltered = rows;
  // URL is the bookmarkable record of the view; replaceState so every tweak
  // doesn't stack a Back entry.
  try { history.replaceState(null, '', location.pathname + CC.toQuery(f) + location.hash); } catch (_) {}
  const nAct = activeFilterCount(f);
  document.getElementById('fActiveN').textContent = nAct ? '(' + nAct + ')' : '';
  renderTotals(rows);
  renderBreakdown('bdMarket', rows, t => t.market, mktLabel);
  renderBreakdown('bdStrat',  rows, t => t.strategyId, stratLabel);
  _lastRollups.daily   = rollup(rows, d => d);
  _lastRollups.weekly  = rollup(rows, weekKey);
  _lastRollups.monthly = rollup(rows, monthKey);
  _lastRollups.yearly  = rollup(rows, yearKey);

  // Reset page on filter change
  ['dailyTbl','monthlyTbl','yearlyTbl','tradesTbl'].forEach(id => { TBL_STATE[id].page = 1; });

  renderRollupTable('dailyTbl',   _lastRollups.daily);
  renderRollupTable('monthlyTbl', _lastRollups.monthly);
  renderRollupTable('yearlyTbl',  _lastRollups.yearly);
  renderTradesTable(rows);
  renderCumChart(rows);
  renderDailyChart();
  if (_dvVisible) buildDayView();
  if (_anaVisible) renderAnalytics();

  const totalPnl = rows.reduce((a, t) => a + (t.pnl || 0), 0);
  const unk = CC.unknownExpiryHidden(TRADES, f, CC.istToday());
  const countHtml =
    \`<strong>\${rows.length}</strong> trades · Net: <span style="color:\${pnlColor(totalPnl)};font-weight:700;">\${totalPnl >= 0 ? '+' : ''}\${fmtINR(totalPnl)}</span>\`
    + (unk ? \` · <span title="These markets have no expiry calendar yet and their records carry no expiry date">\${unk} with unknown expiry left out</span>\` : '');
  document.getElementById('fCount').innerHTML = countHtml;
  document.getElementById('fCountM').innerHTML = countHtml;
}

// ── Day View ─────────────────────────────────────────────────────────────────
let _dvVisible = false;
let _dvDays = [];

function toggleDayView(){
  _dvVisible = !_dvVisible;
  document.getElementById('dayViewPanel').style.display = _dvVisible ? 'block' : 'none';
  document.getElementById('dvToggle').classList.toggle('copied', _dvVisible);
  if (_dvVisible) buildDayView();
}

function buildDayView(){
  const map = new Map();
  for (const t of _lastFiltered){
    const d = t.date || 'Unknown';
    if (!map.has(d)) map.set(d, { date: d, trades: 0, wins: 0, losses: 0, pnl: 0, byMode: Object.fromEntries(ENABLED_MODES.map(m => [m, 0])) });
    const b = map.get(d);
    b.trades++;
    b.pnl += (t.pnl || 0);
    if (t.pnl > 0) b.wins++; else if (t.pnl < 0) b.losses++;
    if (t.mode && b.byMode[t.mode] != null) b.byMode[t.mode]++;
  }
  const days = Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date));
  _dvDays = days;
  const tb = document.querySelector('#dayViewTbl tbody');
  if (!days.length){
    tb.innerHTML = '<tr><td colspan="' + (6 + ENABLED_MODES.length) + '" style="text-align:center;color:var(--muted-1,#8ba1c2);padding:18px;">No data</td></tr>';
    document.getElementById('dvCount').textContent = '';
    return;
  }
  let cum = 0;
  tb.innerHTML = days.map(dy => {
    cum += dy.pnl;
    const pc = pnlColor(dy.pnl), cc = pnlColor(cum);
    const pbg = dy.pnl > 0 ? 'rgba(16,185,129,0.12)' : (dy.pnl < 0 ? 'rgba(239,68,68,0.12)' : 'transparent');
    const cbg = cum    > 0 ? 'rgba(16,185,129,0.12)' : (cum    < 0 ? 'rgba(239,68,68,0.12)' : 'transparent');
    const modeCell = (n, cls) => n ? \`<span class="badge-mode badge-\${cls}">\${n}</span>\` : '<span style="color:var(--muted-2,#6d85a8);">—</span>';
    return \`<tr style="background:\${pnlRowBg(dy.pnl)};">
      <td style="font-weight:600;">\${dy.date}</td>
      <td>\${dy.trades}</td>
      \${ENABLED_MODES.map(m => '<td>' + modeCell(dy.byMode[m], m) + '</td>').join('')}
      <td style="color:#10b981;">\${dy.wins}</td>
      <td style="color:#ef4444;">\${dy.losses}</td>
      <td style="color:\${pc};font-weight:700;background:\${pbg};">\${dy.pnl >= 0 ? '+' : ''}\${fmtINR(dy.pnl)}</td>
      <td style="color:\${cc};font-weight:700;background:\${cbg};">\${cum    >= 0 ? '+' : ''}\${fmtINR(cum)}</td>
    </tr>\`;
  }).join('');
  document.getElementById('dvCount').textContent = days.length + ' day' + (days.length === 1 ? '' : 's');
}

function copyDayView(btn){
  if (!_dvDays.length){ alert('No data to copy.'); return; }
  const lines = [['Date', 'Trades', ...ENABLED_MODES, 'Wins', 'Losses', 'PnL', 'Cumulative PnL'].join('\\t')];
  let cum = 0;
  for (const dy of _dvDays){
    cum += dy.pnl;
    lines.push([dy.date, dy.trades, ...ENABLED_MODES.map(m => dy.byMode[m]), dy.wins, dy.losses, dy.pnl.toFixed(2), cum.toFixed(2)].join('\\t'));
  }
  copyText(lines.join('\\n'), btn);
}

function resetFilters(){
  setState(CC.emptyFilter());
  applyFilters();
}

// Filters apply as they change (search after a short pause) — Apply stays for
// the habit, and for the custom range while both dates are being typed.
function wireFilterControls(){
  Object.keys(F_FIELDS).forEach(k => {
    const el = document.getElementById(F_FIELDS[k]);
    if (!el) return;
    if (k === 'q'){
      let tmr = null;
      el.addEventListener('input', () => { clearTimeout(tmr); tmr = setTimeout(applyFilters, 250); });
    } else {
      el.addEventListener('change', () => { if (k === 'preset') syncCustomVisibility(); applyFilters(); });
    }
  });
}

// Re-render a single table using cached data (used by sort / pagination handlers)
function rerender(tableId){
  if (tableId === 'tradesTbl')   return renderTradesTable(_lastFiltered);
  if (tableId === 'dailyTbl')    return renderRollupTable('dailyTbl',   _lastRollups.daily);
  if (tableId === 'monthlyTbl')  return renderRollupTable('monthlyTbl', _lastRollups.monthly);
  if (tableId === 'yearlyTbl')   return renderRollupTable('yearlyTbl',  _lastRollups.yearly);
}

// Wire sort + pager handlers once
function wireTableControls(){
  ['dailyTbl','monthlyTbl','yearlyTbl','tradesTbl'].forEach(id => {
    document.querySelectorAll(\`#\${id} thead th.sortable\`).forEach(th => {
      th.addEventListener('click', () => {
        const key = th.dataset.key;
        const st = TBL_STATE[id];
        if (st.sortKey === key) st.sortDir = (st.sortDir === 'asc') ? 'desc' : 'asc';
        else { st.sortKey = key; st.sortDir = 'asc'; }
        st.page = 1;
        rerender(id);
      });
    });

    const pager = document.querySelector(\`.pager[data-for="\${id}"]\`);
    if (!pager) return;
    pager.querySelector('.pager-size').addEventListener('change', e => {
      TBL_STATE[id].pageSize = parseInt(e.target.value, 10) || 0;
      TBL_STATE[id].page = 1;
      rerender(id);
    });
    pager.querySelectorAll('.pager-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const st = TBL_STATE[id];
        const a = btn.dataset.action;
        if (a === 'first') st.page = 1;
        if (a === 'prev')  st.page = Math.max(1, st.page - 1);
        if (a === 'next')  st.page = Math.min(st.totalPages, st.page + 1);
        if (a === 'last')  st.page = st.totalPages;
        rerender(id);
      });
    });
  });
}

// ── Analytics Panel ─────────────────────────────────────────────────────────
let _anaVisible = false;
const _anaCharts = {};
const _MODE_COLOR = { EMA_RSI_ST: '#3b82f6', EMA_RSI_ST_V2: '#38bdf8', BB_RSI: '#f59e0b', PA: '#a855f7', ORB: '#10b981', EMA9VWAP: '#06b6d4', TREND_PB: '#ec4899', TDS: '#c084fc', HA_SCALP: '#f97316', PREV_ORB_SCALP: '#e879f9', RSI_PIVOT_ST: '#facc15', SIMPLE930: '#fb923c', EARLYBIRD: '#14b8a6' };
_MODE_COLOR.ST_RSI_PIV_BB = '#a3e635';
_MODE_COLOR.SAIL_VWAP_ST = '#fda4af';
_MODE_COLOR.PIVOT_EMA_ST = '#38bdf8';
_MODE_COLOR.GAP_RUNAWAY = '#a78bfa'; _MODE_COLOR.GAP_RUNAWAY_STK = '#c084fc';
_MODE_COLOR.ITM20_SCALP = '#22d3ee';
// Retired copy books (and any mode added later without a colour) — neutral slate.
ENABLED_MODES.forEach(m => { if (!_MODE_COLOR[m]) _MODE_COLOR[m] = '#94a3b8'; });
// NIFTY FUTURES twins — one amber futures accent.

function fmtAna(v){ return '₹' + Math.round(Math.abs(v||0)).toLocaleString('en-IN'); }
function fmtAnaSigned(v){ const n = v||0; return (n>=0?'+':'-') + '₹' + Math.round(Math.abs(n)).toLocaleString('en-IN'); }
function fmtAnaShort(v){ return Math.abs(v||0)>=1000 ? '₹'+Math.round((v||0)/1000)+'k' : '₹'+Math.round(v||0); }

// ── Generic per-table enhancer: filter + sort + pager for analytics tables ──
const _anaTblState = new Map();
function _anaCellNum(s){
  if (s == null) return null;
  let v = String(s).trim();
  if (!v) return null;
  v = v.replace(/^\\(([\\d.,]+)\\)$/, '-$1');
  if (v === '∞') return Number.POSITIVE_INFINITY;
  if (v === '—' || v === '-' || v === '–') return null;
  const stripped = v.replace(/[₹%,\\s+]/g, '');
  if (/^-?\\d+(\\.\\d+)?$/.test(stripped)) return parseFloat(stripped);
  return null;
}
function _anaParseRows(html){
  const t = document.createElement('table');
  t.innerHTML = '<tbody>' + (html||'') + '</tbody>';
  return [...t.querySelectorAll('tbody > tr')].map(tr => {
    const cells = [...tr.querySelectorAll('td')].map(td => (td.textContent||'').trim());
    return { html: tr.outerHTML, cells, lc: cells.map(c => c.toLowerCase()).join(' \\u0001 ') };
  });
}
function anaEnhance(tbodyId, rowsHtml, emptyHtml, opts){
  opts = opts || {};
  const tb = document.getElementById(tbodyId);
  if (!tb) return;
  const table = tb.closest('table');
  const wrap  = table.parentElement;
  const mini  = wrap.parentElement;

  let st = _anaTblState.get(tbodyId);
  if (!st){
    st = { rows:[], emptyHtml:'', filter:'', sortIdx:-1, sortDir:1, page:0, size:10, opts };
    _anaTblState.set(tbodyId, st);

    if (opts.filter){
      const bar = document.createElement('div');
      bar.className = 'ana-tbl-bar';
      bar.innerHTML = '<input type="text" class="ana-tbl-filter" placeholder="Filter rows..." />'
                    + '<span class="ana-tbl-count"></span>';
      mini.insertBefore(bar, wrap);
      bar.querySelector('.ana-tbl-filter').addEventListener('input', e => {
        st.filter = (e.target.value||'').toLowerCase();
        st.page = 0;
        _anaRenderTbl(tbodyId);
      });
    }

    table.querySelectorAll('thead th').forEach((th, i) => {
      th.classList.add('ana-sortable');
      th.addEventListener('click', () => {
        if (st.sortIdx === i){ st.sortDir = -st.sortDir; }
        else { st.sortIdx = i; st.sortDir = 1; }
        st.page = 0;
        _anaRenderTbl(tbodyId);
      });
    });

    if (opts.pager){
      const pg = document.createElement('div');
      pg.className = 'ana-tbl-pager';
      pg.innerHTML = '<label>Rows</label>'
        + '<select class="ana-tbl-size">'
        +   '<option value="5">5</option>'
        +   '<option value="10" selected>10</option>'
        +   '<option value="25">25</option>'
        +   '<option value="50">50</option>'
        +   '<option value="0">All</option>'
        + '</select>'
        + '<span class="ana-tbl-pager-info"></span>'
        + '<button class="btn" data-act="first" title="First">«</button>'
        + '<button class="btn" data-act="prev"  title="Prev">‹</button>'
        + '<button class="btn" data-act="next"  title="Next">›</button>'
        + '<button class="btn" data-act="last"  title="Last">»</button>';
      wrap.parentNode.insertBefore(pg, wrap.nextSibling);
      pg.querySelector('.ana-tbl-size').addEventListener('change', e => {
        st.size = parseInt(e.target.value, 10) || 0;
        st.page = 0;
        _anaRenderTbl(tbodyId);
      });
      pg.querySelectorAll('button[data-act]').forEach(btn => btn.addEventListener('click', () => {
        const filt = _anaFilteredRows(tbodyId);
        const total = filt.length;
        const sz = st.size || total || 1;
        const last = Math.max(0, Math.ceil(total/sz) - 1);
        const act = btn.dataset.act;
        if (act === 'first') st.page = 0;
        else if (act === 'prev')  st.page = Math.max(0, st.page - 1);
        else if (act === 'next')  st.page = Math.min(last, st.page + 1);
        else if (act === 'last')  st.page = last;
        _anaRenderTbl(tbodyId);
      }));
    }
  }

  st.rows = _anaParseRows(rowsHtml);
  st.emptyHtml = emptyHtml || '';
  _anaRenderTbl(tbodyId);
}
function _anaFilteredRows(tbodyId){
  const st = _anaTblState.get(tbodyId);
  if (!st) return [];
  let rows = st.rows.slice();
  if (st.filter){
    rows = rows.filter(r => r.lc.indexOf(st.filter) !== -1);
  }
  if (st.sortIdx >= 0){
    const idx = st.sortIdx, dir = st.sortDir;
    rows.sort((a,b) => {
      const av = a.cells[idx] || '', bv = b.cells[idx] || '';
      const an = _anaCellNum(av), bn = _anaCellNum(bv);
      let cmp;
      if (an != null && bn != null) cmp = an - bn;
      else cmp = av.localeCompare(bv, undefined, { numeric: true });
      return cmp * dir;
    });
  }
  return rows;
}
function _anaRenderTbl(tbodyId){
  const st = _anaTblState.get(tbodyId);
  if (!st) return;
  const tb = document.getElementById(tbodyId);
  if (!tb) return;
  const table = tb.closest('table');
  const wrap  = table.parentElement;
  const mini  = wrap.parentElement;

  if (!st.rows.length){
    tb.innerHTML = st.emptyHtml || '<tr><td style="text-align:center;color:var(--muted-2,#6d85a8);">No data</td></tr>';
    const bar0 = mini.querySelector('.ana-tbl-bar');
    if (bar0) bar0.querySelector('.ana-tbl-count').textContent = '0 rows';
    const pg0 = mini.querySelector('.ana-tbl-pager');
    if (pg0){
      pg0.querySelector('.ana-tbl-pager-info').textContent = '0–0 of 0';
      pg0.querySelectorAll('button[data-act]').forEach(b => b.disabled = true);
    }
    table.querySelectorAll('thead th').forEach((th, i) => {
      th.classList.remove('ana-sorted-asc','ana-sorted-desc');
      if (i === st.sortIdx) th.classList.add(st.sortDir>0?'ana-sorted-asc':'ana-sorted-desc');
    });
    return;
  }

  const filtered = _anaFilteredRows(tbodyId);
  const total = filtered.length;
  const sz = st.size || total;
  const pgCount = Math.max(1, Math.ceil(total/Math.max(1,sz)));
  if (st.page >= pgCount) st.page = pgCount - 1;
  if (st.page < 0) st.page = 0;
  const start = sz ? st.page*sz : 0;
  const end = sz ? Math.min(total, start + sz) : total;
  const slice = filtered.slice(start, end);

  tb.innerHTML = slice.length
    ? slice.map(r => r.html).join('')
    : '<tr><td colspan="20" style="text-align:center;color:var(--muted-2,#6d85a8);">No rows match filter</td></tr>';

  table.querySelectorAll('thead th').forEach((th, i) => {
    th.classList.remove('ana-sorted-asc','ana-sorted-desc');
    if (i === st.sortIdx) th.classList.add(st.sortDir>0?'ana-sorted-asc':'ana-sorted-desc');
  });
  const bar = mini.querySelector('.ana-tbl-bar');
  if (bar){
    bar.querySelector('.ana-tbl-count').textContent = total + ' row' + (total===1?'':'s')
      + (st.filter ? ' (of ' + st.rows.length + ')' : '');
  }
  const pg = mini.querySelector('.ana-tbl-pager');
  if (pg){
    pg.querySelector('.ana-tbl-pager-info').textContent =
      total === 0 ? '0–0 of 0' : (start+1) + '–' + end + ' of ' + total;
    const bs = pg.querySelectorAll('button[data-act]');
    const firstPage = st.page === 0;
    const lastPage  = st.page >= pgCount - 1;
    bs[0].disabled = bs[1].disabled = firstPage;
    bs[2].disabled = bs[3].disabled = lastPage;
  }
}

// Parse entry/exit time → ms or null. istNow() writes "DD/MM/YYYY, HH:MM:SS";
// older records use "HH:MM, DD/MM/YYYY". Match the halves independently so field
// order doesn't matter — the date half has no colon, the clock half no slash.
function _parseTimeMs(t){
  if (!t) return null;
  const s = String(t);
  const d = s.match(/(\\d{1,2})\\/(\\d{1,2})\\/(\\d{4})/);
  const c = s.match(/(\\d{1,2}):(\\d{2})(?::(\\d{2}))?/);
  if (!d || !c) return null;
  return new Date(+d[3], +d[2]-1, +d[1], +c[1], +c[2], +(c[3]||0)).getTime();
}
function _hourOf(t){
  const ts = t.entryTime || '';
  const m = String(ts).match(/(\\d{1,2}):(\\d{2})/);
  return m ? parseInt(m[1], 10) : null;
}
function _dowOf(t){
  if (!t.date) return null;
  const d = new Date(t.date + 'T00:00:00');
  return isNaN(d) ? null : d.getDay();
}
function _monthOf(t){ return (t.date || '').slice(0, 7); }
function _durMin(t){
  const a = _parseTimeMs(t.entryTime), b = _parseTimeMs(t.exitTime);
  if (a == null || b == null || b < a) return null;
  return Math.round((b - a) / 60000);
}

function toggleAnalytics(){
  _anaVisible = !_anaVisible;
  document.getElementById('anaPanel').style.display = _anaVisible ? 'block' : 'none';
  document.getElementById('anaToggle').classList.toggle('copied', _anaVisible);
  if (_anaVisible) renderAnalytics();
}

function renderAnalytics(){
  const trades = _lastFiltered.slice();
  const isLight = document.documentElement.getAttribute('data-theme') === 'light';
  const _gc = isLight ? '#e0e4ea' : '#0e1e36';
  const _tc = isLight ? '#64748b' : '#3a5070';
  const baseChartOpts = (extra) => Object.assign({
    responsive: true, maintainAspectRatio: false,
    plugins: { legend: { display: false } },
    scales: {
      x: { ticks: { color: _tc, font: { size: 9, family: 'IBM Plex Mono' } }, grid: { display: false } },
      y: { ticks: { color: _tc, font: { size: 10, family: 'IBM Plex Mono' }, callback: v => fmtAnaShort(v) }, grid: { color: _gc } },
    },
  }, extra || {});

  // ── Cross-mode comparison ──
  (function(){
    const modes = ENABLED_MODES;
    const EMPTY = '<tr><td colspan="10" style="text-align:center;color:var(--muted-2,#6d85a8);">No data</td></tr>';
    if (!trades.length){ anaEnhance('anaModeBody', '', EMPTY, {}); return; }
    {
      let html = '';
      const overall = { count:0, wins:0, losses:0, pnl:0, gp:0, gl:0 };
      modes.forEach(m => {
        const sub = trades.filter(t => t.mode === m);
        const wins = sub.filter(t => t.pnl > 0), losses = sub.filter(t => t.pnl < 0);
        const gp = wins.reduce((s,t)=>s+t.pnl,0), gl = losses.reduce((s,t)=>s+t.pnl,0);
        const pnl = sub.reduce((s,t)=>s+(t.pnl||0),0);
        const wr = sub.length ? ((wins.length/sub.length)*100).toFixed(1) : '0.0';
        const aw = wins.length ? Math.round(gp/wins.length) : 0;
        const al = losses.length ? Math.round(gl/losses.length) : 0;
        const pf = gl !== 0 ? (gp / Math.abs(gl)).toFixed(2) : (gp>0?'∞':'—');
        const exp = sub.length ? Math.round(pnl/sub.length) : 0;
        const pc = pnl>=0?'#10b981':'#ef4444';
        const pfNum = parseFloat(pf);
        const pfCol = isNaN(pfNum) ? '#c8d8f0' : (pfNum>=1.5?'#10b981':pfNum>=1?'#f59e0b':'#ef4444');
        html += '<tr>'
          + '<td><span class="badge-mode badge-'+m+'">'+m+'</span></td>'
          + '<td>'+sub.length+'</td>'
          + '<td style="color:#10b981;">'+wins.length+'</td>'
          + '<td style="color:#ef4444;">'+losses.length+'</td>'
          + '<td style="color:'+(parseFloat(wr)>=55?'#10b981':parseFloat(wr)>=45?'#f59e0b':'#ef4444')+';font-weight:700;">'+wr+'%</td>'
          + '<td style="color:'+pc+';font-weight:700;">'+fmtAnaSigned(pnl)+'</td>'
          + '<td style="color:#10b981;">'+fmtAna(aw)+'</td>'
          + '<td style="color:#ef4444;">'+fmtAna(al)+'</td>'
          + '<td style="color:'+pfCol+';font-weight:700;">'+pf+'</td>'
          + '<td style="color:'+(exp>=0?'#10b981':'#ef4444')+';">'+fmtAnaSigned(exp)+'</td>'
          + '</tr>';
        overall.count += sub.length; overall.wins += wins.length; overall.losses += losses.length;
        overall.pnl += pnl; overall.gp += gp; overall.gl += gl;
      });
      const wrAll = overall.count ? ((overall.wins/overall.count)*100).toFixed(1) : '0.0';
      const awAll = overall.wins ? Math.round(overall.gp/overall.wins) : 0;
      const alAll = overall.losses ? Math.round(overall.gl/overall.losses) : 0;
      const pfAll = overall.gl !== 0 ? (overall.gp/Math.abs(overall.gl)).toFixed(2) : (overall.gp>0?'∞':'—');
      const expAll = overall.count ? Math.round(overall.pnl/overall.count) : 0;
      const pcAll = overall.pnl>=0?'#10b981':'#ef4444';
      html += '<tr style="border-top:1px solid #0e1e36;background:rgba(59,130,246,0.04);">'
        + '<td style="font-weight:700;color:#60a5fa;">ALL</td>'
        + '<td style="font-weight:700;">'+overall.count+'</td>'
        + '<td style="color:#10b981;font-weight:700;">'+overall.wins+'</td>'
        + '<td style="color:#ef4444;font-weight:700;">'+overall.losses+'</td>'
        + '<td style="font-weight:700;">'+wrAll+'%</td>'
        + '<td style="color:'+pcAll+';font-weight:700;">'+fmtAnaSigned(overall.pnl)+'</td>'
        + '<td style="color:#10b981;">'+fmtAna(awAll)+'</td>'
        + '<td style="color:#ef4444;">'+fmtAna(alAll)+'</td>'
        + '<td style="font-weight:700;">'+pfAll+'</td>'
        + '<td style="color:'+(expAll>=0?'#10b981':'#ef4444')+';font-weight:700;">'+fmtAnaSigned(expAll)+'</td>'
        + '</tr>';
      anaEnhance('anaModeBody', html, '', {});
    }
  })();

  // ── Risk Metrics ──
  (function(){
    const wins = trades.filter(t=>t.pnl>0), losses = trades.filter(t=>t.pnl<0);
    const totalPnl = trades.reduce((s,t)=>s+(t.pnl||0),0);
    const gp = wins.reduce((s,t)=>s+t.pnl,0), gl = losses.reduce((s,t)=>s+t.pnl,0);
    const pf = gl !== 0 ? (gp/Math.abs(gl)).toFixed(2) : (gp>0?'∞':'—');
    const aw = wins.length ? Math.round(gp/wins.length) : 0;
    const al = losses.length ? Math.round(gl/losses.length) : 0;
    const exp = trades.length ? (totalPnl/trades.length) : 0;
    const payoff = (al !== 0) ? (Math.abs(aw)/Math.abs(al)).toFixed(2) : '—';
    let maxConsLoss = 0, cur = 0;
    trades.forEach(t => { if (t.pnl<0){ cur++; if (cur>maxConsLoss) maxConsLoss = cur; } else cur = 0; });
    const sortedPnl = trades.map(t=>t.pnl||0).sort((a,b)=>a-b);
    const p5 = sortedPnl[Math.floor(sortedPnl.length*0.05)] || 0;
    const p95 = sortedPnl[Math.floor(sortedPnl.length*0.95)] || 0;
    // Sharpe-like (per-trade)
    const mean = trades.length ? totalPnl/trades.length : 0;
    const variance = trades.length ? trades.reduce((s,t)=>s+Math.pow((t.pnl||0)-mean,2),0)/trades.length : 0;
    const stdev = Math.sqrt(variance);
    const sharpe = stdev > 0 ? (mean/stdev).toFixed(2) : '—';
    // Sortino-like
    const negs = trades.filter(t=>(t.pnl||0)<0).map(t=>t.pnl);
    const downVar = negs.length ? negs.reduce((s,v)=>s+v*v,0)/negs.length : 0;
    const downStd = Math.sqrt(downVar);
    const sortino = downStd > 0 ? (mean/downStd).toFixed(2) : '—';
    // Loss-after-loss
    let lossAfterLoss = 0, totalAfterLoss = 0;
    for (let i=1; i<trades.length; i++){ if ((trades[i-1].pnl||0)<0){ totalAfterLoss++; if ((trades[i].pnl||0)<0) lossAfterLoss++; } }
    const lalPct = totalAfterLoss ? ((lossAfterLoss/totalAfterLoss)*100).toFixed(0) : '—';
    const pfNum = parseFloat(pf);
    const pfCol = isNaN(pfNum) ? '#c8d8f0' : (pfNum>=1.5?'#10b981':pfNum>=1?'#f59e0b':'#ef4444');
    document.getElementById('anaRiskMetrics').innerHTML =
      '<div class="ana-stat"><span class="ana-stat-val" style="color:'+pfCol+';">'+pf+'</span><span class="ana-stat-label">Profit Factor</span></div>'
      + '<div class="ana-stat"><span class="ana-stat-val" style="color:'+(exp>=0?'#10b981':'#ef4444')+';">'+fmtAnaSigned(exp)+'</span><span class="ana-stat-label">Expectancy / trade</span></div>'
      + '<div class="ana-stat"><span class="ana-stat-val" style="color:#10b981;">'+fmtAna(aw)+'</span><span class="ana-stat-label">Avg Win</span></div>'
      + '<div class="ana-stat"><span class="ana-stat-val" style="color:#ef4444;">'+fmtAna(al)+'</span><span class="ana-stat-label">Avg Loss</span></div>'
      + '<div class="ana-stat"><span class="ana-stat-val" style="color:#60a5fa;">'+payoff+'</span><span class="ana-stat-label">Payoff (W/L)</span></div>'
      + '<div class="ana-stat"><span class="ana-stat-val" style="color:#ef4444;">'+maxConsLoss+'</span><span class="ana-stat-label">Max consecutive losses</span></div>'
      + '<div class="ana-stat"><span class="ana-stat-val" style="color:'+(parseFloat(lalPct)>=50?'#ef4444':'#10b981')+';">'+lalPct+'%</span><span class="ana-stat-label">Loss-after-loss %</span></div>'
      + '<div style="border-top:0.5px solid #0e1e36;margin:8px 0;padding-top:8px;">'
      + '<div class="ana-stat"><span class="ana-stat-val" style="color:#60a5fa;">'+sharpe+'</span><span class="ana-stat-label">Sharpe-like (μ/σ)</span></div>'
      + '<div class="ana-stat"><span class="ana-stat-val" style="color:#a855f7;">'+sortino+'</span><span class="ana-stat-label">Sortino-like</span></div>'
      + '<div class="ana-stat"><span class="ana-stat-val" style="color:#10b981;">'+fmtAna(p95)+'</span><span class="ana-stat-label">95th pct (best case)</span></div>'
      + '<div class="ana-stat"><span class="ana-stat-val" style="color:#ef4444;">'+fmtAna(Math.abs(p5))+'</span><span class="ana-stat-label">5th pct (worst case)</span></div>'
      + '</div>';
  })();

  // ── Win/Loss Streaks ──
  (function(){
    let maxWS=0, maxLS=0, curWS=0, curLS=0;
    const wsArr = [], lsArr = [];
    trades.forEach(t => {
      if (t.pnl>0){ curWS++; if (curLS>0) lsArr.push(curLS); curLS=0; if (curWS>maxWS) maxWS=curWS; }
      else if (t.pnl<0){ curLS++; if (curWS>0) wsArr.push(curWS); curWS=0; if (curLS>maxLS) maxLS=curLS; }
    });
    if (curWS>0) wsArr.push(curWS); if (curLS>0) lsArr.push(curLS);
    const avgW = wsArr.length ? (wsArr.reduce((a,b)=>a+b,0)/wsArr.length).toFixed(1) : '0';
    const avgL = lsArr.length ? (lsArr.reduce((a,b)=>a+b,0)/lsArr.length).toFixed(1) : '0';
    const dayMap = new Map();
    trades.forEach(t => { const d = t.date||'?'; dayMap.set(d, (dayMap.get(d)||0)+(t.pnl||0)); });
    let profDays=0, lossDays=0;
    for (const v of dayMap.values()){ if (v>=0) profDays++; else lossDays++; }
    const totalDays = profDays + lossDays;
    const avgDaily = totalDays ? Array.from(dayMap.values()).reduce((a,b)=>a+b,0)/totalDays : 0;
    document.getElementById('anaStreaks').innerHTML =
      '<div class="ana-stat"><span class="ana-stat-val" style="color:#10b981;">'+maxWS+'</span><span class="ana-stat-label">Best win streak</span></div>'
      + '<div class="ana-stat"><span class="ana-stat-val" style="color:#ef4444;">'+maxLS+'</span><span class="ana-stat-label">Worst loss streak</span></div>'
      + '<div class="ana-stat"><span class="ana-stat-val" style="color:#60a5fa;">'+avgW+'</span><span class="ana-stat-label">Avg win streak</span></div>'
      + '<div class="ana-stat"><span class="ana-stat-val" style="color:#f59e0b;">'+avgL+'</span><span class="ana-stat-label">Avg loss streak</span></div>'
      + '<div style="border-top:0.5px solid #0e1e36;margin:8px 0;padding-top:8px;">'
      + '<div class="ana-stat"><span class="ana-stat-val" style="color:#10b981;">'+profDays+'</span><span class="ana-stat-label">Profitable days ('+(totalDays?((profDays/totalDays)*100).toFixed(0):'0')+'%)</span></div>'
      + '<div class="ana-stat"><span class="ana-stat-val" style="color:#ef4444;">'+lossDays+'</span><span class="ana-stat-label">Losing days ('+(totalDays?((lossDays/totalDays)*100).toFixed(0):'0')+'%)</span></div>'
      + '<div class="ana-stat"><span class="ana-stat-val" style="color:'+(avgDaily>=0?'#10b981':'#ef4444')+';">'+fmtAnaSigned(avgDaily)+'</span><span class="ana-stat-label">Avg daily P&amp;L</span></div>'
      + '</div>';
  })();

  // ── Day of Week ──
  (function(){
    const dow = {0:{n:'Sun',t:0,w:0,p:0},1:{n:'Mon',t:0,w:0,p:0},2:{n:'Tue',t:0,w:0,p:0},3:{n:'Wed',t:0,w:0,p:0},4:{n:'Thu',t:0,w:0,p:0},5:{n:'Fri',t:0,w:0,p:0},6:{n:'Sat',t:0,w:0,p:0}};
    trades.forEach(t => { const d=_dowOf(t); if (d==null) return; dow[d].t++; if (t.pnl>0) dow[d].w++; dow[d].p+=(t.pnl||0); });
    let html = '';
    [1,2,3,4,5].forEach(d => { const dd=dow[d]; if (!dd.t) return;
      const wr = ((dd.w/dd.t)*100).toFixed(0);
      const pc = dd.p>=0?'#10b981':'#ef4444';
      html += '<tr><td style="font-weight:600;">'+dd.n+'</td><td>'+dd.t+'</td><td style="color:'+(parseFloat(wr)>=55?'#10b981':'#ef4444')+';">'+wr+'%</td><td style="color:'+pc+';font-weight:700;">'+fmtAnaSigned(dd.p)+'</td><td style="color:'+pc+';">'+fmtAnaSigned(Math.round(dd.p/dd.t))+'</td></tr>';
    });
    anaEnhance('anaDowBody', html, '<tr><td colspan="5" style="text-align:center;color:var(--muted-2,#6d85a8);">No data</td></tr>', {});
  })();

  // ── Equity Curve (per trade, oldest → newest by entry time) ──
  (function(){
    const sorted = trades.slice().sort((a,b) => {
      const ta = _parseTimeMs(a.entryTime), tb = _parseTimeMs(b.entryTime);
      if (ta!=null && tb!=null) return ta - tb;
      return (a.date||'').localeCompare(b.date||'');
    });
    let eq = 0;
    const data = sorted.map(t => (eq += (t.pnl||0)));
    const labels = sorted.map((_, i) => i+1);
    if (_anaCharts.equity) _anaCharts.equity.destroy();
    _anaCharts.equity = new Chart(document.getElementById('anaEquity'), {
      type: 'line',
      data: { labels, datasets: [{ data, borderColor: '#3b82f6', backgroundColor: 'rgba(59,130,246,0.10)', borderWidth: 1.5, fill: true, pointRadius: 0, tension: 0.25 }] },
      options: baseChartOpts({ plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => 'Equity: '+fmtAna(c.raw) } } }, scales: { x: { display: false }, y: { ticks: { color: _tc, callback: v => fmtAnaShort(v) }, grid: { color: _gc } } } }),
    });
  })();

  // ── Monthly P&L (overall) ──
  (function(){
    const m = new Map();
    trades.forEach(t => { const k=_monthOf(t); if (!k) return; m.set(k, (m.get(k)||0)+(t.pnl||0)); });
    const keys = Array.from(m.keys()).sort();
    const monthNames = ['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const labels = keys.map(k => monthNames[parseInt(k.slice(5,7),10)] + " '" + k.slice(2,4));
    const vals = keys.map(k => Math.round(m.get(k)));
    const colors = vals.map(v => v>=0?'#10b981':'#ef4444');
    if (_anaCharts.monthly) _anaCharts.monthly.destroy();
    _anaCharts.monthly = new Chart(document.getElementById('anaMonthly'), {
      type: 'bar',
      data: { labels, datasets: [{ data: vals, backgroundColor: colors, borderRadius: 4, barPercentage: 0.7 }] },
      options: baseChartOpts({ plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => fmtAnaSigned(c.raw) } } } }),
    });
  })();

  // ── Drawdown ──
  (function(){
    const sorted = trades.slice().sort((a,b) => {
      const ta = _parseTimeMs(a.entryTime), tb = _parseTimeMs(b.entryTime);
      if (ta!=null && tb!=null) return ta - tb;
      return (a.date||'').localeCompare(b.date||'');
    });
    let eq=0, peak=0;
    const dd = [], labels = [];
    sorted.forEach((t,i) => { eq+=(t.pnl||0); if (eq>peak) peak=eq; dd.push(eq-peak); labels.push(i+1); });
    if (_anaCharts.dd) _anaCharts.dd.destroy();
    _anaCharts.dd = new Chart(document.getElementById('anaDrawdown'), {
      type: 'line',
      data: { labels, datasets: [{ data: dd, borderColor: '#ef4444', backgroundColor: 'rgba(239,68,68,0.12)', borderWidth: 1.5, fill: true, pointRadius: 0, tension: 0.25 }] },
      options: baseChartOpts({ plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => 'DD: '+fmtAna(c.raw) } } }, scales: { x: { display: false }, y: { ticks: { color: _tc, callback: v => fmtAnaShort(v) }, grid: { color: _gc } } } }),
    });
  })();

  // ── Hourly Performance ──
  (function(){
    const hourMap = {};
    trades.forEach(t => { const h=_hourOf(t); if (h==null) return; if (!hourMap[h]) hourMap[h]={pnl:0,cnt:0,wins:0}; hourMap[h].pnl+=(t.pnl||0); hourMap[h].cnt++; if (t.pnl>0) hourMap[h].wins++; });
    const hours = Object.keys(hourMap).map(Number).sort((a,b)=>a-b);
    const labels = hours.map(h => h+':00');
    const vals = hours.map(h => Math.round(hourMap[h].pnl));
    const colors = vals.map(v => v>=0 ? 'rgba(16,185,129,0.7)' : 'rgba(239,68,68,0.7)');
    if (_anaCharts.hourly) _anaCharts.hourly.destroy();
    _anaCharts.hourly = new Chart(document.getElementById('anaHourly'), {
      type: 'bar',
      data: { labels, datasets: [{ data: vals, backgroundColor: colors, borderRadius: 4, barPercentage: 0.7 }] },
      options: baseChartOpts({ plugins: { legend: { display: false }, tooltip: { callbacks: { title: c => { const h = hours[c[0].dataIndex]; return h+':00 ('+hourMap[h].cnt+' trades, '+((hourMap[h].wins/hourMap[h].cnt)*100).toFixed(0)+'% WR)'; }, label: c => fmtAnaSigned(c.raw) } } } }),
    });
  })();

  // ── Entry Reason Breakdown ──
  (function(){
    const map = new Map();
    trades.forEach(t => {
      let r = (t.entryReason || 'Unknown'); if (r.length > 60) r = r.slice(0,60)+'…';
      const key = r + '|' + t.mode;
      if (!map.has(key)) map.set(key, { reason: r, mode: t.mode, cnt: 0, wins: 0, losses: 0, pnl: 0 });
      const b = map.get(key);
      b.cnt++; b.pnl += (t.pnl||0);
      if (t.pnl>0) b.wins++; else if (t.pnl<0) b.losses++;
    });
    const rows = Array.from(map.values()).sort((a,b)=>b.cnt-a.cnt);
    let html = '';
    rows.forEach(d => {
      const pc = d.pnl>=0?'#10b981':'#ef4444';
      const wr = d.cnt ? ((d.wins/d.cnt)*100).toFixed(0) : '0';
      html += '<tr>'
        + '<td style="max-width:220px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="'+esc(d.reason)+'">'+esc(d.reason)+'</td>'
        + '<td><span class="badge-mode badge-'+d.mode+'">'+d.mode+'</span></td>'
        + '<td>'+d.cnt+'</td>'
        + '<td style="color:#10b981;">'+d.wins+'</td>'
        + '<td style="color:#ef4444;">'+d.losses+'</td>'
        + '<td style="color:'+(parseFloat(wr)>=55?'#10b981':'#ef4444')+';">'+wr+'%</td>'
        + '<td style="color:'+pc+';font-weight:700;">'+fmtAnaSigned(d.pnl)+'</td>'
        + '<td style="color:'+pc+';">'+fmtAnaSigned(Math.round(d.pnl/d.cnt))+'</td>'
        + '</tr>';
    });
    anaEnhance('anaEntryBody', html, '<tr><td colspan="8" style="text-align:center;color:var(--muted-2,#6d85a8);">No data</td></tr>', { filter:true, pager:true });
  })();

  // ── Exit Reason Breakdown ──
  (function(){
    const map = new Map();
    trades.forEach(t => {
      const r = t.exitReason || 'Unknown';
      const key = r + '|' + t.mode;
      if (!map.has(key)) map.set(key, { reason: r, mode: t.mode, cnt: 0, pnl: 0 });
      const b = map.get(key); b.cnt++; b.pnl += (t.pnl||0);
    });
    const rows = Array.from(map.values()).sort((a,b) => b.pnl - a.pnl);
    let html = '';
    rows.forEach(d => {
      const pc = d.pnl>=0?'#10b981':'#ef4444';
      html += '<tr><td style="max-width:220px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="'+esc(d.reason)+'">'+esc(d.reason)+'</td>'
        + '<td><span class="badge-mode badge-'+d.mode+'">'+d.mode+'</span></td>'
        + '<td>'+d.cnt+'</td>'
        + '<td style="color:'+pc+';font-weight:700;">'+fmtAnaSigned(d.pnl)+'</td>'
        + '<td style="color:'+pc+';">'+fmtAnaSigned(Math.round(d.pnl/d.cnt))+'</td></tr>';
    });
    anaEnhance('anaExitBody', html, '<tr><td colspan="5" style="text-align:center;color:var(--muted-2,#6d85a8);">No data</td></tr>', { filter:true, pager:true });
  })();

  // ── Loss Distribution ──
  (function(){
    const lossTrades = trades.filter(t => t.pnl<0);
    if (_anaCharts.lossDist) _anaCharts.lossDist.destroy();
    if (!lossTrades.length){
      _anaCharts.lossDist = new Chart(document.getElementById('anaLossDist'), { type: 'bar', data: { labels: [], datasets: [{ data: [] }] }, options: baseChartOpts() });
      return;
    }
    const vals = lossTrades.map(t => Math.abs(t.pnl)).sort((a,b)=>a-b);
    const maxV = vals[vals.length-1];
    const buckets = Math.min(12, Math.max(5, Math.ceil(Math.sqrt(vals.length))));
    let step = Math.ceil(maxV/buckets/100)*100; if (step<1) step=1;
    const bins = new Array(buckets).fill(0), labels = [];
    for (let i=0;i<buckets;i++) labels.push(fmtAnaShort(i*step)+'–'+fmtAnaShort((i+1)*step));
    vals.forEach(v => { const idx = Math.min(Math.floor(v/step), buckets-1); bins[idx]++; });
    _anaCharts.lossDist = new Chart(document.getElementById('anaLossDist'), {
      type: 'bar',
      data: { labels, datasets: [{ data: bins, backgroundColor: 'rgba(239,68,68,0.6)', borderRadius: 4, barPercentage: 0.85 }] },
      options: baseChartOpts({ plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => c.raw+' trades ('+((c.raw/lossTrades.length)*100).toFixed(0)+'%)' } } }, scales: { x: { ticks: { color: _tc, font: { size: 9, family: 'IBM Plex Mono' }, maxRotation: 45 }, grid: { display: false } }, y: { ticks: { color: _tc, stepSize: 1 }, grid: { color: _gc } } } }),
    });
  })();

  // ── CE vs PE Performance (overall) ──
  (function(){
    const sides = { CE: { wins: 0, losses: 0, winPnl: 0, lossPnl: 0, total: 0 }, PE: { wins: 0, losses: 0, winPnl: 0, lossPnl: 0, total: 0 } };
    trades.forEach(t => { const s = t.side; if (!sides[s]) return; sides[s].total++; if (t.pnl>0){ sides[s].wins++; sides[s].winPnl+=t.pnl; } else if (t.pnl<0){ sides[s].losses++; sides[s].lossPnl+=t.pnl; } });
    const labels = ['CE','PE'].map(s => s+' ('+sides[s].total+' · '+((sides[s].wins/Math.max(sides[s].total,1))*100).toFixed(0)+'% WR)');
    const winPnl = ['CE','PE'].map(s => Math.round(sides[s].winPnl));
    const lossPnl = ['CE','PE'].map(s => Math.round(sides[s].lossPnl));
    const net = ['CE','PE'].map(s => Math.round(sides[s].winPnl + sides[s].lossPnl));
    if (_anaCharts.side) _anaCharts.side.destroy();
    _anaCharts.side = new Chart(document.getElementById('anaSidePerf'), {
      type: 'bar',
      data: { labels, datasets: [
        { label: 'Win P&L',  data: winPnl,  backgroundColor: 'rgba(16,185,129,0.65)', borderRadius: 4, barPercentage: 0.6 },
        { label: 'Loss P&L', data: lossPnl, backgroundColor: 'rgba(239,68,68,0.65)', borderRadius: 4, barPercentage: 0.6 },
        { label: 'Net P&L',  data: net,     backgroundColor: net.map(v => v>=0?'rgba(59,130,246,0.65)':'rgba(245,158,11,0.65)'), borderRadius: 4, barPercentage: 0.6 },
      ] },
      options: baseChartOpts({ plugins: { legend: { labels: { color: _tc, font: { size: 9, family: 'IBM Plex Mono' } } } } }),
    });
  })();

  // ── Top 10 Worst Trades ──
  (function(){
    const worst = trades.filter(t=>t.pnl<0).sort((a,b)=>a.pnl-b.pnl).slice(0,10);
    let html = '';
    worst.forEach(t => {
      html += '<tr><td>'+(t.date||'—')+'</td><td><span class="badge-mode badge-'+t.mode+'">'+t.mode+'</span></td><td><span class="badge '+(t.side==='CE'?'badge-ce':'badge-pe')+'">'+(t.side||'—')+'</span></td><td style="color:#ef4444;font-weight:700;">'+fmtAnaSigned(t.pnl)+'</td><td style="font-size:0.65rem;max-width:160px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="'+esc(t.exitReason)+'">'+esc(t.exitReason||'—')+'</td></tr>';
    });
    anaEnhance('anaWorstBody', html, '<tr><td colspan="5" style="text-align:center;color:var(--muted-2,#6d85a8);">No losing trades</td></tr>', {});
  })();

  // ── Consecutive Loss Streaks ──
  (function(){
    const streaks = []; let cur = [];
    trades.forEach((t,i) => { if (t.pnl<0) cur.push({t,i}); else { if (cur.length>=2) streaks.push(cur.slice()); cur = []; } });
    if (cur.length>=2) streaks.push(cur.slice());
    streaks.sort((a,b) => a.reduce((s,c)=>s+c.t.pnl,0) - b.reduce((s,c)=>s+c.t.pnl,0));
    let html = '';
    streaks.slice(0,10).forEach(s => {
      const total = s.reduce((sum,c)=>sum+c.t.pnl,0);
      const avg = total / s.length;
      html += '<tr><td>'+(s[0].t.date||'—')+'</td><td>'+s.length+'</td><td style="color:#ef4444;font-weight:700;">'+fmtAnaSigned(total)+'</td><td style="color:#ef4444;">'+fmtAnaSigned(avg)+'</td></tr>';
    });
    anaEnhance('anaLossStreakBody', html, '<tr><td colspan="4" style="text-align:center;color:var(--muted-2,#6d85a8);">No loss streaks (2+)</td></tr>', { pager:true });
  })();

  // ── Worst/Best Trading Days ──
  (function(){
    const m = new Map();
    trades.forEach(t => { const d=t.date||'?'; if (!m.has(d)) m.set(d, { date: d, trades: 0, pnl: 0, losses: 0, wins: 0, worst: 0, best: 0 }); const b=m.get(d); b.trades++; b.pnl+=(t.pnl||0); if (t.pnl<0){ b.losses++; if (t.pnl<b.worst) b.worst=t.pnl; } if (t.pnl>0){ b.wins++; if (t.pnl>b.best) b.best=t.pnl; } });
    const arr = Array.from(m.values());
    const lossDays = arr.filter(d=>d.pnl<0).sort((a,b)=>a.pnl-b.pnl).slice(0,10);
    let html = '';
    lossDays.forEach(d => { html += '<tr><td>'+d.date+'</td><td>'+d.trades+'</td><td style="color:#ef4444;font-weight:700;">'+fmtAnaSigned(d.pnl)+'</td><td>'+d.losses+'</td><td style="color:#ef4444;">'+fmtAnaSigned(d.worst)+'</td></tr>'; });
    anaEnhance('anaWorstDayBody', html, '<tr><td colspan="5" style="text-align:center;color:var(--muted-2,#6d85a8);">No losing days</td></tr>', { filter:true, pager:true });
    const winDays = arr.filter(d=>d.pnl>0).sort((a,b)=>b.pnl-a.pnl).slice(0,10);
    let html2 = '';
    winDays.forEach(d => { html2 += '<tr><td>'+d.date+'</td><td>'+d.trades+'</td><td style="color:#10b981;font-weight:700;">'+fmtAnaSigned(d.pnl)+'</td><td>'+d.wins+'</td><td style="color:#10b981;">'+fmtAnaSigned(d.best)+'</td></tr>'; });
    anaEnhance('anaBestDayBody', html2, '<tr><td colspan="5" style="text-align:center;color:var(--muted-2,#6d85a8);">No winning days</td></tr>', { filter:true, pager:true });
  })();

  // ── Loss by Exit Reason ──
  (function(){
    const lossTrades = trades.filter(t=>t.pnl<0);
    const m = new Map();
    lossTrades.forEach(t => { const r = t.exitReason||'Unknown'; if (!m.has(r)) m.set(r, { cnt: 0, pnl: 0 }); const b = m.get(r); b.cnt++; b.pnl += t.pnl; });
    const rows = Array.from(m.entries()).sort((a,b) => a[1].pnl - b[1].pnl);
    let html = '';
    rows.forEach(([r,d]) => {
      const pct = ((d.cnt/Math.max(lossTrades.length,1))*100).toFixed(0);
      html += '<tr><td style="max-width:220px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="'+esc(r)+'">'+esc(r)+'</td><td>'+d.cnt+'</td><td style="color:#ef4444;font-weight:700;">'+fmtAnaSigned(d.pnl)+'</td><td style="color:#ef4444;">'+fmtAnaSigned(Math.round(d.pnl/d.cnt))+'</td><td style="font-weight:600;">'+pct+'%</td></tr>';
    });
    anaEnhance('anaLossReasonBody', html, '<tr><td colspan="5" style="text-align:center;color:var(--muted-2,#6d85a8);">No losses</td></tr>', {});
  })();

  // ── Losing Hours / Winning Hours ──
  (function(){
    const m = {};
    trades.forEach(t => { const h=_hourOf(t); if (h==null) return; if (!m[h]) m[h]={total:0,wins:0,losses:0,winPnl:0,lossPnl:0}; m[h].total++; if (t.pnl>0){ m[h].wins++; m[h].winPnl+=t.pnl; } else if (t.pnl<0){ m[h].losses++; m[h].lossPnl+=t.pnl; } });
    const hours = Object.keys(m).map(Number).sort((a,b)=>a-b);
    let lh = '', wh = '';
    hours.forEach(h => {
      const d = m[h];
      if (d.losses > 0){
        const pct = ((d.losses/d.total)*100).toFixed(0);
        const col = parseFloat(pct)>=60?'#ef4444':parseFloat(pct)>=45?'#f59e0b':'#10b981';
        lh += '<tr><td style="font-weight:600;">'+h+':00</td><td>'+d.losses+' / '+d.total+'</td><td style="color:#ef4444;font-weight:700;">'+fmtAnaSigned(d.lossPnl)+'</td><td style="color:#ef4444;">'+fmtAnaSigned(Math.round(d.lossPnl/d.losses))+'</td><td style="color:'+col+';font-weight:700;">'+pct+'%</td></tr>';
      }
      if (d.wins > 0){
        const pct = ((d.wins/d.total)*100).toFixed(0);
        const col = parseFloat(pct)>=60?'#10b981':parseFloat(pct)>=45?'#f59e0b':'#ef4444';
        wh += '<tr><td style="font-weight:600;">'+h+':00</td><td>'+d.wins+' / '+d.total+'</td><td style="color:#10b981;font-weight:700;">'+fmtAnaSigned(d.winPnl)+'</td><td style="color:#10b981;">'+fmtAnaSigned(Math.round(d.winPnl/d.wins))+'</td><td style="color:'+col+';font-weight:700;">'+pct+'%</td></tr>';
      }
    });
    anaEnhance('anaLossHourBody', lh, '<tr><td colspan="5" style="text-align:center;color:var(--muted-2,#6d85a8);">No data</td></tr>', {});
    anaEnhance('anaWinHourBody', wh, '<tr><td colspan="5" style="text-align:center;color:var(--muted-2,#6d85a8);">No data</td></tr>', {});
  })();

  // ── Day-wise Loss ──
  (function(){
    const m = new Map();
    trades.forEach(t => { const d=t.date||'?'; if (!m.has(d)) m.set(d, { trades:0, losses:0, gross:0, net:0 }); const b=m.get(d); b.trades++; b.net+=(t.pnl||0); if (t.pnl<0){ b.losses++; b.gross+=t.pnl; } });
    const days = Array.from(m.keys()).sort();
    let html = '';
    days.forEach(d => { const b=m.get(d); const nc=b.net>=0?'#10b981':'#ef4444'; html += '<tr><td>'+d+'</td><td>'+b.trades+'</td><td style="color:#ef4444;">'+b.losses+'</td><td style="color:#ef4444;font-weight:700;">'+(b.gross<0?fmtAnaSigned(b.gross):'—')+'</td><td style="color:'+nc+';font-weight:700;">'+fmtAnaSigned(b.net)+'</td></tr>'; });
    anaEnhance('anaDayLossBody', html, '<tr><td colspan="5" style="text-align:center;color:var(--muted-2,#6d85a8);">No data</td></tr>', { pager:true });
  })();

  // ── Losses by Candles Held ──
  (function(){
    const lossTrades = trades.filter(t=>t.pnl<0);
    const ch = t => (t.candlesHeld!=null ? t.candlesHeld : (t.held!=null ? t.held : null));
    const rows = lossTrades.slice().sort((a,b)=>{ const ca=ch(a), cb=ch(b); return (cb==null?-1:cb)-(ca==null?-1:ca); });
    let html = '';
    rows.forEach(t => { const c=ch(t); html += '<tr><td>'+(t.date||'—')+'</td><td><span class="badge-mode badge-'+t.mode+'">'+t.mode+'</span></td><td><span class="badge '+(t.side==='CE'?'badge-ce':'badge-pe')+'">'+(t.side||'—')+'</span></td><td style="color:#c8d8f0;font-weight:700;">'+(c==null?'—':c)+'</td><td style="color:#ef4444;font-weight:700;">'+fmtAnaSigned(t.pnl)+'</td><td style="font-size:0.65rem;max-width:160px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="'+esc(t.exitReason)+'">'+esc(t.exitReason||'—')+'</td></tr>'; });
    anaEnhance('anaLossCandleBody', html, '<tr><td colspan="6" style="text-align:center;color:var(--muted-2,#6d85a8);">No losing trades</td></tr>', { pager:true });
  })();

  // ── Top 10 Best Trades ──
  (function(){
    const best = trades.filter(t=>t.pnl>0).sort((a,b)=>b.pnl-a.pnl).slice(0,10);
    let html = '';
    best.forEach(t => {
      html += '<tr><td>'+(t.date||'—')+'</td><td><span class="badge-mode badge-'+t.mode+'">'+t.mode+'</span></td><td><span class="badge '+(t.side==='CE'?'badge-ce':'badge-pe')+'">'+(t.side||'—')+'</span></td><td style="color:#10b981;font-weight:700;">'+fmtAnaSigned(t.pnl)+'</td><td style="font-size:0.65rem;max-width:160px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="'+esc(t.exitReason)+'">'+esc(t.exitReason||'—')+'</td></tr>';
    });
    anaEnhance('anaBestBody', html, '<tr><td colspan="5" style="text-align:center;color:var(--muted-2,#6d85a8);">No winning trades</td></tr>', {});
  })();

  // ── Cumulative P&L by Mode ──
  (function(){
    const modes = ENABLED_MODES;
    const sorted = trades.slice().sort((a,b) => {
      const ta = _parseTimeMs(a.entryTime), tb = _parseTimeMs(b.entryTime);
      if (ta!=null && tb!=null) return ta - tb;
      return (a.date||'').localeCompare(b.date||'');
    });
    const labels = sorted.map((_,i)=>i+1);
    const dsets = modes.map(m => {
      let eq = 0;
      const data = sorted.map(t => { if (t.mode===m) eq += (t.pnl||0); return eq; });
      return { label: m, data, borderColor: _MODE_COLOR[m], backgroundColor: _MODE_COLOR[m]+'22', borderWidth: 1.5, fill: false, pointRadius: 0, tension: 0.25 };
    });
    if (_anaCharts.cumByMode) _anaCharts.cumByMode.destroy();
    _anaCharts.cumByMode = new Chart(document.getElementById('anaCumByMode'), {
      type: 'line',
      data: { labels, datasets: dsets },
      options: baseChartOpts({ plugins: { legend: { display: true, labels: { color: _tc, font: { size: 10, family: 'IBM Plex Mono' } } }, tooltip: { callbacks: { label: c => c.dataset.label+': '+fmtAna(c.raw) } } }, scales: { x: { display: false }, y: { ticks: { color: _tc, callback: v => fmtAnaShort(v) }, grid: { color: _gc } } } }),
    });
  })();

  // ── Monthly P&L stacked by mode ──
  (function(){
    const modes = ENABLED_MODES;
    const monthsSet = new Set();
    const data = {}; modes.forEach(m => data[m] = new Map());
    trades.forEach(t => { const k=_monthOf(t); if (!k) return; monthsSet.add(k); if (!data[t.mode]) return; data[t.mode].set(k, (data[t.mode].get(k)||0) + (t.pnl||0)); });
    const keys = Array.from(monthsSet).sort();
    const monthNames = ['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const labels = keys.map(k => monthNames[parseInt(k.slice(5,7),10)] + " '" + k.slice(2,4));
    const dsets = modes.map(m => ({ label: m, data: keys.map(k => Math.round(data[m].get(k)||0)), backgroundColor: _MODE_COLOR[m], borderRadius: 3 }));
    if (_anaCharts.monthlyStacked) _anaCharts.monthlyStacked.destroy();
    _anaCharts.monthlyStacked = new Chart(document.getElementById('anaMonthlyStacked'), {
      type: 'bar',
      data: { labels, datasets: dsets },
      options: baseChartOpts({ plugins: { legend: { display: true, labels: { color: _tc, font: { size: 10, family: 'IBM Plex Mono' } } }, tooltip: { callbacks: { label: c => c.dataset.label+': '+fmtAnaSigned(c.raw) } } }, scales: { x: { stacked: true, ticks: { color: _tc, font: { size: 9, family: 'IBM Plex Mono' } }, grid: { display: false } }, y: { stacked: true, ticks: { color: _tc, callback: v => fmtAnaShort(v) }, grid: { color: _gc } } } }),
    });
  })();

  // ── P&L Distribution (all trades, signed) ──
  (function(){
    if (!trades.length){ if (_anaCharts.pnlDist) _anaCharts.pnlDist.destroy(); return; }
    const vals = trades.map(t => t.pnl||0);
    const mn = Math.min.apply(null, vals), mx = Math.max.apply(null, vals);
    const span = mx - mn;
    const buckets = Math.min(20, Math.max(8, Math.ceil(Math.sqrt(vals.length))));
    const step = span > 0 ? span/buckets : 1;
    const bins = new Array(buckets).fill(0), labels = [], colors = [];
    for (let i=0;i<buckets;i++){
      const lo = mn + i*step, hi = lo + step;
      labels.push(fmtAnaShort(lo) + '…' + fmtAnaShort(hi));
      colors.push((lo+hi)/2 >= 0 ? 'rgba(16,185,129,0.6)' : 'rgba(239,68,68,0.6)');
    }
    vals.forEach(v => { const idx = Math.min(buckets-1, Math.max(0, Math.floor((v-mn)/step))); bins[idx]++; });
    if (_anaCharts.pnlDist) _anaCharts.pnlDist.destroy();
    _anaCharts.pnlDist = new Chart(document.getElementById('anaPnlDist'), {
      type: 'bar',
      data: { labels, datasets: [{ data: bins, backgroundColor: colors, borderRadius: 3, barPercentage: 0.9 }] },
      options: baseChartOpts({ plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => c.raw+' trades ('+((c.raw/vals.length)*100).toFixed(1)+'%)' } } }, scales: { x: { ticks: { color: _tc, font: { size: 8, family: 'IBM Plex Mono' }, maxRotation: 60 }, grid: { display: false } }, y: { ticks: { color: _tc, stepSize: 1 }, grid: { color: _gc } } } }),
    });
  })();

  // ── Rolling 30-trade WR ──
  (function(){
    const sorted = trades.slice().sort((a,b) => {
      const ta = _parseTimeMs(a.entryTime), tb = _parseTimeMs(b.entryTime);
      if (ta!=null && tb!=null) return ta - tb;
      return (a.date||'').localeCompare(b.date||'');
    });
    const WIN = 30;
    const labels = [], data = [];
    for (let i=0; i<sorted.length; i++){
      const start = Math.max(0, i - WIN + 1);
      const slice = sorted.slice(start, i+1);
      const w = slice.filter(t=>t.pnl>0).length;
      labels.push(i+1);
      data.push(slice.length ? +((w/slice.length)*100).toFixed(1) : 0);
    }
    if (_anaCharts.rollWr) _anaCharts.rollWr.destroy();
    _anaCharts.rollWr = new Chart(document.getElementById('anaRollWr'), {
      type: 'line',
      data: { labels, datasets: [{ data, borderColor: '#a855f7', backgroundColor: 'rgba(168,85,247,0.10)', borderWidth: 1.5, fill: true, pointRadius: 0, tension: 0.25 }] },
      options: baseChartOpts({ plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => 'WR: '+c.raw+'%' } } }, scales: { x: { display: false }, y: { min: 0, max: 100, ticks: { color: _tc, callback: v => v+'%' }, grid: { color: _gc } } } }),
    });
  })();

  // ── Trade Duration Distribution + buckets table ──
  (function(){
    const durs = trades.map(t => ({ d: _durMin(t), p: t.pnl||0 })).filter(x => x.d != null);
    if (_anaCharts.durDist) _anaCharts.durDist.destroy();
    if (!durs.length){
      anaEnhance('anaDurBody', '', '<tr><td colspan="6" style="text-align:center;color:var(--muted-2,#6d85a8);">No duration data</td></tr>', {});
      _anaCharts.durDist = new Chart(document.getElementById('anaDurDist'), { type: 'bar', data: { labels: [], datasets: [{ data: [] }] }, options: baseChartOpts() });
      return;
    }
    const buckets = [
      { lbl: '0–5m',     min: 0,    max: 5 },
      { lbl: '5–15m',    min: 5,    max: 15 },
      { lbl: '15–30m',   min: 15,   max: 30 },
      { lbl: '30–60m',   min: 30,   max: 60 },
      { lbl: '1–2h',     min: 60,   max: 120 },
      { lbl: '2–4h',     min: 120,  max: 240 },
      { lbl: '4h+',      min: 240,  max: Infinity },
    ];
    const bins = buckets.map(()=> ({ cnt: 0, wins: 0, pnl: 0 }));
    durs.forEach(x => { for (let i=0;i<buckets.length;i++){ if (x.d >= buckets[i].min && x.d < buckets[i].max){ bins[i].cnt++; if (x.p>0) bins[i].wins++; bins[i].pnl+=x.p; break; } } });
    const labels = buckets.map(b => b.lbl);
    const cntVals = bins.map(b => b.cnt);
    const cntCols = bins.map(b => b.pnl>=0 ? 'rgba(16,185,129,0.6)' : 'rgba(239,68,68,0.6)');
    _anaCharts.durDist = new Chart(document.getElementById('anaDurDist'), {
      type: 'bar',
      data: { labels, datasets: [{ data: cntVals, backgroundColor: cntCols, borderRadius: 4, barPercentage: 0.75 }] },
      options: baseChartOpts({ plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => bins[c.dataIndex].cnt+' trades · P&L '+fmtAnaSigned(bins[c.dataIndex].pnl) } } }, scales: { x: { ticks: { color: _tc, font: { size: 9, family: 'IBM Plex Mono' } }, grid: { display: false } }, y: { ticks: { color: _tc, stepSize: 1 }, grid: { color: _gc } } } }),
    });
    let html = '';
    buckets.forEach((b,i) => { const d=bins[i]; if (!d.cnt) return; const wr = ((d.wins/d.cnt)*100).toFixed(0); const pc = d.pnl>=0?'#10b981':'#ef4444';
      html += '<tr><td style="font-weight:600;">'+b.lbl+'</td><td>'+d.cnt+'</td><td style="color:#10b981;">'+d.wins+'</td><td style="color:'+(parseFloat(wr)>=55?'#10b981':'#ef4444')+';">'+wr+'%</td><td style="color:'+pc+';font-weight:700;">'+fmtAnaSigned(d.pnl)+'</td><td style="color:'+pc+';">'+fmtAnaSigned(Math.round(d.pnl/d.cnt))+'</td></tr>'; });
    anaEnhance('anaDurBody', html, '<tr><td colspan="6" style="text-align:center;color:var(--muted-2,#6d85a8);">No duration data</td></tr>', {});
  })();

  // ── NIFTY spot move (points) distribution ──
  (function(){
    const moves = [];
    trades.forEach(t => {
      const e = t.spotAtEntry, x = t.spotAtExit;
      if (typeof e !== 'number' || typeof x !== 'number' || !t.side) return;
      const m = (t.side === 'PE') ? (e - x) : (x - e);
      moves.push(m);
    });
    if (_anaCharts.spotMove) _anaCharts.spotMove.destroy();
    if (!moves.length){
      _anaCharts.spotMove = new Chart(document.getElementById('anaSpotMove'), { type: 'bar', data: { labels: [], datasets: [{ data: [] }] }, options: baseChartOpts() });
      return;
    }
    const mn = Math.min.apply(null, moves), mx = Math.max.apply(null, moves);
    const span = mx - mn || 1;
    const buckets = Math.min(16, Math.max(6, Math.ceil(Math.sqrt(moves.length))));
    const step = span/buckets;
    const bins = new Array(buckets).fill(0), labels = [], colors = [];
    for (let i=0;i<buckets;i++){ const lo = mn + i*step, hi = lo + step; labels.push(lo.toFixed(0)+'…'+hi.toFixed(0)); colors.push((lo+hi)/2 >= 0 ? 'rgba(16,185,129,0.6)' : 'rgba(239,68,68,0.6)'); }
    moves.forEach(v => { const idx = Math.min(buckets-1, Math.max(0, Math.floor((v-mn)/step))); bins[idx]++; });
    _anaCharts.spotMove = new Chart(document.getElementById('anaSpotMove'), {
      type: 'bar',
      data: { labels, datasets: [{ data: bins, backgroundColor: colors, borderRadius: 3, barPercentage: 0.9 }] },
      options: baseChartOpts({ plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => c.raw+' trades ('+((c.raw/moves.length)*100).toFixed(1)+'%)' } } }, scales: { x: { ticks: { color: _tc, font: { size: 8, family: 'IBM Plex Mono' }, maxRotation: 60 }, grid: { display: false } }, y: { ticks: { color: _tc, stepSize: 1 }, grid: { color: _gc } } } }),
    });
  })();

  // ── Day × Hour Heatmap (Net P&L) ──
  (function(){
    const cells = {};
    trades.forEach(t => { const dow=_dowOf(t), h=_hourOf(t); if (dow==null || h==null) return; const k = dow+'_'+h; cells[k] = (cells[k]||0) + (t.pnl||0); });
    const hours = [9,10,11,12,13,14,15];
    const days = [{i:1,n:'Mon'},{i:2,n:'Tue'},{i:3,n:'Wed'},{i:4,n:'Thu'},{i:5,n:'Fri'}];
    let absMax = 1;
    Object.values(cells).forEach(v => { if (Math.abs(v) > absMax) absMax = Math.abs(v); });
    function col(v){
      if (!v) return 'rgba(74,96,128,0.10)';
      const ratio = Math.min(1, Math.abs(v)/absMax);
      const alpha = (0.15 + 0.6*ratio).toFixed(2);
      return v>0 ? 'rgba(16,185,129,'+alpha+')' : 'rgba(239,68,68,'+alpha+')';
    }
    let html = '<table style="border-collapse:collapse;width:100%;font-size:0.6rem;font-family:IBM Plex Mono,monospace;"><thead><tr><th style="padding:4px;color:'+_tc+';">Day\\\\Hr</th>';
    hours.forEach(h => { html += '<th style="padding:4px;color:'+_tc+';">'+h+':00</th>'; });
    html += '</tr></thead><tbody>';
    days.forEach(d => {
      html += '<tr><td style="padding:4px;color:#c8d8f0;font-weight:600;">'+d.n+'</td>';
      hours.forEach(h => { const v = cells[d.i+'_'+h] || 0; const c = col(v); const lbl = v ? fmtAnaShort(v) : '·'; const tc = !v ? '#3a5070' : (v>=0?'#10b981':'#ef4444');
        html += '<td style="padding:6px 4px;background:'+c+';color:'+tc+';text-align:center;border:1px solid '+_gc+';font-weight:700;" title="'+d.n+' '+h+':00 — '+fmtAnaSigned(v)+'">'+lbl+'</td>'; });
      html += '</tr>';
    });
    html += '</tbody></table>';
    document.getElementById('anaHeatmap').innerHTML = html;
  })();

  // ── Weekly Performance ──
  (function(){
    const m = new Map();
    trades.forEach(t => { const k = weekKey(t.date); if (!k) return; if (!m.has(k)) m.set(k, { key: k, trades: 0, wins: 0, pnl: 0 }); const b=m.get(k); b.trades++; if (t.pnl>0) b.wins++; b.pnl += (t.pnl||0); });
    const rows = Array.from(m.values()).sort((a,b)=>b.key.localeCompare(a.key));
    let html = '';
    rows.forEach(d => { const wr = d.trades ? ((d.wins/d.trades)*100).toFixed(0) : '0'; const pc = d.pnl>=0?'#10b981':'#ef4444';
      html += '<tr><td style="font-weight:600;">'+d.key+'</td><td>'+d.trades+'</td><td style="color:#10b981;">'+d.wins+'</td><td style="color:'+(parseFloat(wr)>=55?'#10b981':'#ef4444')+';">'+wr+'%</td><td style="color:'+pc+';font-weight:700;">'+fmtAnaSigned(d.pnl)+'</td><td style="color:'+pc+';">'+fmtAnaSigned(Math.round(d.pnl/d.trades))+'</td></tr>'; });
    anaEnhance('anaWeeklyBody', html, '<tr><td colspan="6" style="text-align:center;color:var(--muted-2,#6d85a8);">No data</td></tr>', { filter:true, pager:true });
  })();

  // ── Drawdown stats ──
  (function(){
    const sorted = trades.slice().sort((a,b) => {
      const ta = _parseTimeMs(a.entryTime), tb = _parseTimeMs(b.entryTime);
      if (ta!=null && tb!=null) return ta - tb;
      return (a.date||'').localeCompare(b.date||'');
    });
    let eq = 0, peak = 0, maxDd = 0, maxDdEnd = -1;
    let inDd = false, ddLen = 0, maxDdLen = 0, curRecovery = 0, maxRecovery = 0;
    sorted.forEach((t,i) => {
      eq += (t.pnl||0);
      if (eq > peak){ peak = eq; if (inDd){ if (curRecovery > maxRecovery) maxRecovery = curRecovery; } inDd = false; ddLen = 0; curRecovery = 0; }
      else if (eq < peak){ inDd = true; ddLen++; curRecovery++; if (ddLen > maxDdLen) maxDdLen = ddLen; if (eq - peak < maxDd){ maxDd = eq - peak; maxDdEnd = i; } }
    });
    const totalPnl = eq;
    const ddPct = peak > 0 ? ((Math.abs(maxDd)/peak)*100).toFixed(1) : '—';
    document.getElementById('anaDdStats').innerHTML =
      '<div class="ana-stat"><span class="ana-stat-val" style="color:#ef4444;">'+fmtAna(Math.abs(maxDd))+'</span><span class="ana-stat-label">Max drawdown</span></div>'
      + '<div class="ana-stat"><span class="ana-stat-val" style="color:#f59e0b;">'+ddPct+'%</span><span class="ana-stat-label">Max DD as % of peak</span></div>'
      + '<div class="ana-stat"><span class="ana-stat-val" style="color:#a855f7;">'+maxDdLen+'</span><span class="ana-stat-label">Longest DD (trades)</span></div>'
      + '<div class="ana-stat"><span class="ana-stat-val" style="color:#60a5fa;">'+maxRecovery+'</span><span class="ana-stat-label">Longest recovery (trades)</span></div>'
      + '<div class="ana-stat"><span class="ana-stat-val" style="color:'+(totalPnl>=0?'#10b981':'#ef4444')+';">'+fmtAnaSigned(totalPnl)+'</span><span class="ana-stat-label">Final equity</span></div>'
      + '<div class="ana-stat"><span class="ana-stat-val" style="color:#10b981;">'+fmtAna(peak)+'</span><span class="ana-stat-label">Peak equity</span></div>';
  })();

  // ── Top option symbols / strikes / expiries ──
  function _topTable(keyFn, bodyId){
    const m = new Map();
    trades.forEach(t => { const k = keyFn(t); if (k == null || k === '') return; if (!m.has(k)) m.set(k, { key: k, cnt: 0, wins: 0, pnl: 0 }); const b=m.get(k); b.cnt++; if (t.pnl>0) b.wins++; b.pnl += (t.pnl||0); });
    const rows = Array.from(m.values()).sort((a,b) => b.cnt - a.cnt);
    let html = '';
    rows.forEach(d => { const wr = d.cnt ? ((d.wins/d.cnt)*100).toFixed(0) : '0'; const pc = d.pnl>=0?'#10b981':'#ef4444';
      html += '<tr><td style="max-width:160px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="'+esc(d.key)+'">'+esc(d.key)+'</td><td>'+d.cnt+'</td><td style="color:'+(parseFloat(wr)>=55?'#10b981':'#ef4444')+';">'+wr+'%</td><td style="color:'+pc+';font-weight:700;">'+fmtAnaSigned(d.pnl)+'</td></tr>'; });
    anaEnhance(bodyId, html, '<tr><td colspan="4" style="text-align:center;color:var(--muted-2,#6d85a8);">No data</td></tr>', { filter:true, pager:true });
  }
  _topTable(t => t.symbol, 'anaSymBody');
  _topTable(t => t.optionStrike, 'anaStrikeBody');
  _topTable(t => t.optionExpiry, 'anaExpiryBody');

  // ── Strategy variant breakdown ──
  (function(){
    const m = new Map();
    trades.forEach(t => { const s = t.strategy || 'default'; const k = s + '|' + t.mode; if (!m.has(k)) m.set(k, { strat: s, mode: t.mode, cnt: 0, wins: 0, pnl: 0 }); const b=m.get(k); b.cnt++; if (t.pnl>0) b.wins++; b.pnl += (t.pnl||0); });
    const rows = Array.from(m.values()).sort((a,b)=>b.cnt-a.cnt);
    let html = '';
    rows.forEach(d => { const wr = d.cnt ? ((d.wins/d.cnt)*100).toFixed(0) : '0'; const pc = d.pnl>=0?'#10b981':'#ef4444';
      html += '<tr><td style="max-width:160px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="'+esc(d.strat)+'">'+esc(d.strat)+'</td><td><span class="badge-mode badge-'+d.mode+'">'+d.mode+'</span></td><td>'+d.cnt+'</td><td style="color:'+(parseFloat(wr)>=55?'#10b981':'#ef4444')+';">'+wr+'%</td><td style="color:'+pc+';font-weight:700;">'+fmtAnaSigned(d.pnl)+'</td><td style="color:'+pc+';">'+fmtAnaSigned(Math.round(d.pnl/d.cnt))+'</td></tr>'; });
    anaEnhance('anaStratBody', html, '<tr><td colspan="6" style="text-align:center;color:var(--muted-2,#6d85a8);">No data</td></tr>', { filter:true, pager:true });
  })();

  // ── Quantity Buckets ──
  (function(){
    const m = new Map();
    trades.forEach(t => { const q = t.qty || 0; if (!q) return; if (!m.has(q)) m.set(q, { q, cnt: 0, wins: 0, pnl: 0 }); const b=m.get(q); b.cnt++; if (t.pnl>0) b.wins++; b.pnl += (t.pnl||0); });
    const rows = Array.from(m.values()).sort((a,b) => a.q - b.q);
    let html = '';
    rows.forEach(d => { const wr = d.cnt ? ((d.wins/d.cnt)*100).toFixed(0) : '0'; const pc = d.pnl>=0?'#10b981':'#ef4444';
      html += '<tr><td style="font-weight:600;">'+d.q+'</td><td>'+d.cnt+'</td><td style="color:'+(parseFloat(wr)>=55?'#10b981':'#ef4444')+';">'+wr+'%</td><td style="color:'+pc+';font-weight:700;">'+fmtAnaSigned(d.pnl)+'</td><td style="color:'+pc+';">'+fmtAnaSigned(Math.round(d.pnl/d.cnt))+'</td></tr>'; });
    anaEnhance('anaQtyBody', html, '<tr><td colspan="5" style="text-align:center;color:var(--muted-2,#6d85a8);">No data</td></tr>', {});
  })();
}

wireTableControls();
wireFilterControls();
setState(CC.parseQuery(location.search));
applyFilters();
</script>
</body>
</html>`;

  res.send(html);
});

// JSON endpoint — used by dashboard cumulative P&L chart. loadAllTrades()
// already drops strategies toggled off in Settings; the dashboard's legacy
// ?enabledOnly=1 flag is accepted and means the same thing.
//
// The dashboard polls this every 8s in-session, and re-stringifying every trade
// each time is the expensive part. The body depends only on the trade files
// (mtime+size signature) and on which strategies are enabled (process.env, read
// live) — no query param changes it — so one cached string keyed on both is
// enough. Sent exactly as res.json() would: same bytes, same Content-Type.
let _dataBody = null;
let _dataKey  = null;
router.get("/data", (req, res) => {
  const key = _sourcesSig() + "#" + SOURCES.map((src) => (_modeEnabled(src.mode) ? "1" : "0")).join("");
  if (_dataBody === null || key !== _dataKey) {
    _dataBody = JSON.stringify({ success: true, trades: loadAllTrades() });
    _dataKey  = key;
  }
  if (!res.get("Content-Type")) res.set("Content-Type", "application/json");
  res.send(_dataBody);
});

// ── Trade detail (the sheet a tapped trade opens) ────────────────────────────
// Returns the trade's journal (read from its own book) and its full post-exit
// record. Old trades have no journal: { journal: null } and the sheet shows
// "not recorded" for those parts.
router.get("/trade-detail", (req, res) => {
  const id = String(req.query.id || "").slice(0, 200);
  const mode = String(req.query.mode || "").slice(0, 80) || null;
  if (!id) return res.status(400).json({ success: false, error: "id required" });
  try {
    const journal = journalsFor([id], mode).get(id) || (mode ? journalsFor([id], null).get(id) : null) || null;
    const row = loadConsolidatedTrades().trades.find((t) => t.journalId === id) || null;
    res.json({ success: true, journal, postExit: postExitRecordFor(row) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Daily export on demand (utils/dailyExport — CSV + summary JSON) ──────────
router.post("/export-day", express.json({ limit: "2kb" }), (req, res) => {
  const date = String((req.body && req.body.date) || req.query.date || "").trim() || null;
  const out = require("../utils/dailyExport").writeDay(date);
  if (!out.ok) return res.status(out.error && out.error.startsWith("Exports never run") ? 409 : 400).json({ success: false, error: out.error });
  res.json({ success: true, date: out.date, trades: out.trades,
    csv: path.basename(out.csvPath), summary: path.basename(out.summaryPath), net: out.summary.net });
});

// ── Helper used in the outer HTML template (server-side) ──────────────────────
function fmtINR(n) {
  if (typeof n !== "number" || isNaN(n)) return "—";
  return "₹" + n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

module.exports = router;
// Exposed so the consolidated EOD Telegram report computes off the exact same
// paper-only trade set + counting as this page (no parallel source list) —
// keeps the two from drifting. See consolidatedEodReporter.js.
module.exports.loadAllTrades = loadAllTrades;
// The consolidated page's own set (enabled + retired copy books, annotated) —
// exported for tests/consolidation.regression.js.
module.exports.loadConsolidatedTrades = loadConsolidatedTrades;
// Trade journals / per-row extras — for the detail sheet, utils/dailyExport and tests.
module.exports.journalsFor = journalsFor;
module.exports.extraOf = extraOf;
module.exports.postExitRecordFor = postExitRecordFor;

/**
 * PAPER TRADE — /gap_runaway_stk-paper   (GAP_runAway__Kirubakaran · STOCK SCANNER · intraday shares)
 * ─────────────────────────────────────────────────────────────────────────────
 * The NIFTY strategy's rules run over a stock universe (default: every F&O
 * stock), and the best hits are paper-traded as INTRADAY SHARES (MIS):
 *   CE signal → BUY the shares (long) · PE signal → SHORT-SELL the shares.
 * NO real orders are placed — paper only (there is no live harness for this
 * page: the shared harness only knows options). Every RULE lives in
 * src/strategies/gap_runaway.js (env prefix "GAP_RUNAWAY_STK"); this route
 * computes no indicator and makes no threshold comparison of its own.
 * Reference video: GAP_RUNAWAY_STK_REFERENCE_URL.
 *
 *   SCAN   : at /start, every symbol in GAP_RUNAWAY_STK_UNIVERSE gets its daily
 *            series (swingScanner's rate-limited, cached fetch — ~75s for ~220
 *            names) and engine.dailySetup(): yesterday's RSI(10) on EMA21 and
 *            close. Only OVERSOLD / OVERBOUGHT names become candidates.
 *   OPEN   : from GAP_RUNAWAY_STK_ENTRY_START (09:15) the candidates' quotes are
 *            read in batches of 50 — today's official open = the quote's
 *            open_price. A quote whose prev_close disagrees with the daily
 *            history by > 2% is refused (unadjusted split / stale data).
 *   ENTRY  : engine.getSignal() per candidate; hits are RANKED by |gap %| and the
 *            biggest fill first, up to GAP_RUNAWAY_STK_MAX_TRADES per day (3),
 *            one trade per stock per day, no re-entry after any exit. A hit whose
 *            price has already filled the gap is skipped (engine.entryStillValid)
 *            and the next one takes the slot. Fill = the current LTP; qty =
 *            floor(GAP_RUNAWAY_STK_TRADE_AMOUNT ÷ LTP). Entries stop at ENTRY_END.
 *   EXIT   : per price update (socket stream, REST fallback every 2s) — price
 *            back at yesterday's close = gap stop. Per CLOSED EXIT_TF-min candle
 *            (Fyers history, fetched just after each close) — close back through
 *            EMA21 = trail exit. GAP_RUNAWAY_STK_EOD_EXIT_TIME (15:15) square-off.
 *   P&L    : share price move × qty, minus Zerodha equity-intraday charges.
 *
 * COMMON RULES (user, 2026-10-28 — added after a +₹2.4k day closed at −₹1.9k):
 *   profit lock + breakeven (the common % applied to the SHARE price — a short
 *   is checked on the price mirrored around its entry), wait-after-exit,
 *   bid-ask spread check, portfolio daily cap.
 * DELIBERATELY NOT HERE: the common 10:00–14:00 trade window (the whole rule
 * is the 09:15 gap — the window would block every entry), lot multiplier
 * (shares are sized by ₹ amount), no VIX / OI / volume / trend filter, no
 * backtest, no replay, no live orders. Money comes
 * from the shared ZERODHA capital pool (the user's call: one pool for all).
 * A restart mid-day restores today's open paper positions from
 * ~/trading-data/.gap_runaway_stk_positions.json on the next /start.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const express = require("express");
const router  = express.Router();
const fs      = require("fs");
const path    = require("path");
const os      = require("os");

const engine            = require("../strategies/gap_runaway");
const sharedSocketState = require("../utils/sharedSocketState");
const socketManager     = require("../utils/socketManager");
const optionFeed        = require("../utils/optionFeed");
const stockUniverse     = require("../utils/stockUniverse");
const swingScanner      = require("../services/swingScanner");
const tradeLogger       = require("../utils/tradeLogger");
const skipLogger        = require("../utils/skipLogger");
const capitalPool       = require("../utils/capitalPool");
const tradeGuards       = require("../utils/tradeGuards");
const portfolioRisk     = require("../utils/portfolioRisk");
const aiExport         = require("../utils/aiExport");
const { verifyFyersToken } = require("../utils/fyersAuthCheck");
const { isTradingAllowed } = require("../utils/nseHolidays");
const { istDayFromAny }    = require("../utils/tradeUtils");
const { buildSidebar, sidebarCSS, modalCSS, modalJS } = require("../utils/sharedNav");
const { dailyFilesPaginate, renderHistoryPage } = require("../utils/paperHistoryUI");
const fyers = require("../config/fyers");
const { notifyEntry, notifyExit, notifyStarted, sendTelegram, canSend } = require("../utils/notify");

const PREFIX    = "GAP_RUNAWAY_STK";
const MODE_KEY  = "gap_runaway_stk";          // tradeLogger / skipLogger key
const MODE_TAG  = "GAP_RUNAWAY_STK-PAPER";     // notify tag
const LABEL     = `${engine.LABEL} · Stocks`;
const SOCKET_CALLBACK_ID = "gap_runaway_stk-paper";
const NIFTY_INDEX_SYMBOL = "NSE:NIFTY50-INDEX";  // heartbeat only — keeps the shared socket up for the stock streams

const DATA_DIR = path.join(os.homedir(), "trading-data");
const PT_FILE  = path.join(DATA_DIR, "gap_runaway_stk_paper_trades.json");
const POS_FILE = path.join(DATA_DIR, ".gap_runaway_stk_positions.json");

const LOOP_MS          = 1000;   // the engine loop — every check below is driven from here
const QUOTE_POLL_MS    = 2000;   // REST price poll for held stocks whose stream is not fresh
const OPEN_POLL_MS     = 5000;   // candidates' open quotes, until every open is known
const OPEN_WAIT_MS     = 30000;  // a candidate with no open_price this long after the first read is dropped
const TRAIL_FETCH_LAG_S = 20;    // fetch the exit-TF bar this long after it closes (Fyers finalises it)
const PREV_CLOSE_TOLERANCE = 0.02; // quote prev_close vs history close — beyond this the data is refused
const QUOTE_BATCH      = 50;     // Fyers getQuotes accepts up to 50 symbols per call
const SCAN_CONCURRENCY = 4;

// ── Own settings ─────────────────────────────────────────────────────────────
// The common profit lock / breakeven numbers (Settings → Common Rules), read
// here only for the log lines — the checks themselves read them in tradeGuards.
function _plArmPct()   { return parseFloat(process.env.PROFIT_LOCK_ARM_PCT || "8"); }
function _plFloorPct() { return parseFloat(process.env.PROFIT_LOCK_FLOOR_PCT || "5"); }
function _beArmPct()   { return parseFloat(process.env.BREAKEVEN_ARM_PCT || "5"); }
function _plOn() { return String(process.env.PROFIT_LOCK_ENABLED ?? "true").toLowerCase() === "true"; }
function _beOn() { return String(process.env.BREAKEVEN_STOP_ENABLED ?? "true").toLowerCase() === "true"; }
function _tradeAmount() { const v = parseFloat(process.env.GAP_RUNAWAY_STK_TRADE_AMOUNT || "100000"); return Number.isFinite(v) && v > 0 ? v : 100000; }
function _maxTrades()   { const v = parseInt(process.env.GAP_RUNAWAY_STK_MAX_TRADES || "3", 10); return Number.isFinite(v) && v >= 1 && v <= 20 ? v : 3; }
function _universeKey() { return String(process.env.GAP_RUNAWAY_STK_UNIVERSE || "FNO").trim().toUpperCase() || "FNO"; }
function getCapitalFromEnv() { const v = parseFloat(process.env.ZERODHA_INV_AMOUNT || "100000"); return Number.isFinite(v) && v > 0 ? v : 100000; }   // the shared Zerodha pool
function _cfg() { return engine.getConfig(PREFIX); }

// ── Helpers ──────────────────────────────────────────────────────────────────
function _r2(x) { return Math.round(x * 100) / 100; }
function istNow() {
  const ist = new Date(Date.now() + 19800000);
  const p = (n) => (n < 10 ? "0" : "") + n;
  return `${p(ist.getUTCDate())}/${p(ist.getUTCMonth() + 1)}/${ist.getUTCFullYear()}, ${p(ist.getUTCHours())}:${p(ist.getUTCMinutes())}:${p(ist.getUTCSeconds())}`;
}
function _todayStr() { return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }); }
function _todayKey() { return engine._istDayOf(Math.floor(Date.now() / 1000)); }
function _nowMins() { return engine._istMins(Math.floor(Date.now() / 1000)); }
function _daysAgoStr(n) {
  const d = new Date(Date.now() + 19800000 - n * 86400000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}
function parseMins(envKey, def) {
  const [h, m] = String(process.env[envKey] || def).split(":").map(Number);
  return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
}
function _stopMins() { return parseMins("TRADE_STOP_TIME", "15:30"); }

/**
 * Zerodha equity-intraday (MIS) charges for one round trip. Brokerage 0.03% or
 * ₹20 per executed order (lower), STT 0.025% on the sell leg, NSE transaction
 * 0.00297%, SEBI 0.0001%, stamp 0.003% on the buy leg, GST 18% on
 * brokerage + transaction + SEBI. Real-world cost, not a strategy rule.
 */
function misCharges(side, entryPx, exitPx, qty) {
  const buyPx  = side === "CE" ? entryPx : exitPx;
  const sellPx = side === "CE" ? exitPx  : entryPx;
  const buyVal = buyPx * qty, sellVal = sellPx * qty;
  if (!(buyVal > 0) || !(sellVal > 0)) return 0;
  const brokerage = Math.min(20, 0.0003 * buyVal) + Math.min(20, 0.0003 * sellVal);
  const stt   = 0.00025 * sellVal;
  const txn   = 0.0000297 * (buyVal + sellVal);
  const sebi  = 0.000001 * (buyVal + sellVal);
  const stamp = 0.00003 * buyVal;
  const gst   = 0.18 * (brokerage + txn + sebi);
  return _r2(brokerage + stt + txn + sebi + stamp + gst);
}

// ── Persistence ──────────────────────────────────────────────────────────────
let _paperDataCache = null;
function loadPaperData() {
  if (_paperDataCache) return _paperDataCache;
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(PT_FILE)) {
    _paperDataCache = { capital: getCapitalFromEnv(), totalPnl: 0, sessions: [] };
    fs.writeFileSync(PT_FILE, JSON.stringify(_paperDataCache, null, 2));
    return _paperDataCache;
  }
  try { _paperDataCache = JSON.parse(fs.readFileSync(PT_FILE, "utf-8")); }
  catch (e) {
    console.error(`[GAP_RUNAWAY_STK-PAPER] trades file corrupt — resetting: ${e.message}`);
    _paperDataCache = { capital: getCapitalFromEnv(), totalPnl: 0, sessions: [] };
    fs.writeFileSync(PT_FILE, JSON.stringify(_paperDataCache, null, 2));
  }
  return _paperDataCache;
}
function savePaperData(data) {
  const tmp = PT_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, PT_FILE);
  _paperDataCache = data;
}
/** Today's open paper positions — written on every entry / exit (atomic). */
function _savePositions() {
  try {
    const list = [...st.positions.values()].map(p => Object.assign({}, p, { ltp: undefined }));
    const tmp = POS_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ savedDate: _todayStr(), savedAt: Date.now(), positions: list }, null, 2));
    fs.renameSync(tmp, POS_FILE);
  } catch (e) { log(`⚠️ [STK] Could not save open positions: ${e.message}`); }
}
function _loadPositions() {
  try {
    if (!fs.existsSync(POS_FILE)) return [];
    const d = JSON.parse(fs.readFileSync(POS_FILE, "utf-8"));
    if (!d || d.savedDate !== _todayStr() || !Array.isArray(d.positions)) return [];
    return d.positions.filter(p => p && p.stock && (p.side === "CE" || p.side === "PE") && engine._num(p.entryPrice) && engine._num(p.stopLoss) && p.qty > 0);
  } catch (_) { return []; }
}

// The day's settled decisions (per stock) and whether entries are over — kept
// on disk so a stop → start inside the window cannot re-decide them (a name
// skipped as "gap already filled" must not be bought on a restart).
const DAY_FILE = path.join(DATA_DIR, ".gap_runaway_stk_day.json");
const FINAL_STATUSES = new Set(["none", "skipped", "refused", "missed", "entered", "exited"]);
function _saveDay() {
  try {
    const final = {};
    for (const d of st.decisions.values()) if (FINAL_STATUSES.has(d.status)) final[d.stock] = { status: d.status, note: d.note };
    const tmp = DAY_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ date: _todayStr(), dayDone: st._dayDone ? st._dayDoneReason : null, final }));
    fs.renameSync(tmp, DAY_FILE);
  } catch (e) { log(`⚠️ [STK] Could not save today's decisions: ${e.message}`); }
}
function _loadDay() {
  try {
    if (!fs.existsSync(DAY_FILE)) return null;
    const d = JSON.parse(fs.readFileSync(DAY_FILE, "utf-8"));
    return d && d.date === _todayStr() ? d : null;
  } catch (_) { return null; }
}

// ── State ────────────────────────────────────────────────────────────────────
function _freshScan() {
  return { status: "idle", startedAt: null, finishedAt: null, universe: null, total: 0, done: 0,
           failed: [], ready: 0, notReady: 0, candidates: [], error: null };
}
let st = {
  running: false,
  sessionStart: null,
  log: [],
  scan: _freshScan(),
  // stock → { stock, fyersSym, setup, open, openSrc, signal, status, note }
  decisions: new Map(),
  _opensDone: false,
  positions: new Map(),          // stock → position
  sessionTrades: [],
  sessionPnl: 0,
  wins: 0, losses: 0,
  _priorTradesToday: 0,
  _tradedToday: new Set(),       // stocks already traded today (earlier sessions included)
  _dayDone: false,
  _dayDoneReason: null,
  updates: 0,                    // price updates received (stream + REST)
  _staleSession: false,
};
let _loopTimer = null;
let _autoStopTimer = null;
let _sessionGen = 0;
let _busy = { quotes: false, opens: false, trail: false, entry: false };
let _lastQuoteMs = 0, _lastOpenMs = 0;

function log(msg) {
  const entry = `[${istNow()}] ${msg}`;
  console.log(entry);
  st.log.push(entry);
  if (st.log.length > 2500) st.log.splice(0, st.log.length - 2000);
}

// ── Restart rehydrate: today's closed trades from the day file ──────────────
function _rehydrate() {
  try {
    const data = loadPaperData();
    const keyOf = (t) => String(t.entryTime || "") + "|" + String(t.stock || t.symbol || "");
    const saved = new Set();
    for (const s of (data.sessions || [])) for (const t of (s.trades || [])) saved.add(keyOf(t));
    const today = tradeLogger.istDateString(Date.now());
    const all = tradeLogger.readDailyTrades(MODE_KEY, today).filter(t => t && !t.type && t.stock);
    let trades = all.filter(t => !saved.has(keyOf(t)));
    let stale = false;
    if (!trades.length) {
      const withTrades = (data.sessions || []).filter(s => Array.isArray(s.trades) && s.trades.length);
      if (withTrades.length) {
        const last = withTrades.reduce((a, b) => (istDayFromAny(b.date) > istDayFromAny(a.date) ? b : a));
        trades = last.trades;
        stale = all.length === 0;
      }
    }
    if (!trades.length) return;
    st._staleSession = stale;
    st.sessionTrades = trades;
    st.sessionPnl = _r2(trades.reduce((s, t) => s + (Number(t.pnl) || 0), 0));
    st.wins = trades.filter(t => Number(t.pnl) > 0).length;
    st.losses = trades.filter(t => Number(t.pnl) < 0).length;
  } catch (e) { console.warn(`[GAP_RUNAWAY_STK-PAPER] rehydrate failed: ${e.message}`); }
}
_rehydrate();
// A previous day's session may only stay on screen while the market is shut.
// (wins / losses are counted from sessionTrades wherever they are shown, so the
// gate clearing sessionTrades keeps them consistent.)
require("../utils/staleSessionGate").clearStaleSessionOnTradingDay(() => st, "[GAP_RUNAWAY_STK-PAPER]");

// ── The scan: daily setups for the whole universe ────────────────────────────
async function _runScan(gen) {
  const cfg = _cfg();
  const key = _universeKey();
  const syms = stockUniverse.getUniverse(key);
  const scan = st.scan;
  scan.status = "running"; scan.startedAt = Date.now(); scan.universe = key;
  scan.total = syms.length; scan.done = 0; scan.failed = []; scan.ready = 0; scan.notReady = 0; scan.candidates = [];
  if (!syms.length) {
    scan.status = "error"; scan.error = `Universe "${key}" is empty or unknown`;
    log(`❌ [STK] ${scan.error} — no scan, no trades today.`);
    return;
  }
  log(`🔎 [STK] Scanning ${syms.length} stocks (${key}) — daily RSI(${cfg.RSI_LENGTH}) on EMA(${cfg.EMA_LENGTH}) of yesterday's close…`);
  const forDay = _todayKey();
  const results = await swingScanner.mapLimit(syms, SCAN_CONCURRENCY, async (sym) => {
    const fsym = stockUniverse.fyersSymbol(sym);
    const daily = await swingScanner.getSeries(fsym, "D", engine.DAILY_LOOKBACK_DAYS);
    return { sym, fsym, setup: engine.dailySetup(daily, forDay, cfg) };
  }, (done) => { scan.done = done; }, () => !st.running || gen !== _sessionGen);
  if (!st.running || gen !== _sessionGen) return;
  results.forEach((r, i) => {
    if (!r) return;
    if (!r.ok) { scan.failed.push({ stock: syms[i], error: String(r.error || "failed").slice(0, 120) }); return; }
    const s = r.value.setup;
    if (!s.ready) { scan.notReady++; return; }
    scan.ready++;
    if (s.zone === "OVERSOLD" || s.zone === "OVERBOUGHT") {
      scan.candidates.push({ stock: r.value.sym, fyersSym: r.value.fsym, setup: s });
    }
  });
  scan.candidates.sort((a, b) => a.stock.localeCompare(b.stock));
  const _prior = (st._dayFinal || {});
  for (const c of scan.candidates) {
    if (!st.decisions.has(c.stock)) {
      const was = _prior[c.stock];
      st.decisions.set(c.stock, was
        ? { stock: c.stock, fyersSym: c.fyersSym, setup: c.setup, open: null, openSrc: null, signal: null, status: was.status, note: `${was.note || was.status} (decided earlier today)` }
        : { stock: c.stock, fyersSym: c.fyersSym, setup: c.setup, open: null, openSrc: null, signal: null, status: "waiting_open", note: null });
    }
  }
  scan.status = "done"; scan.finishedAt = Date.now();
  const os_ = scan.candidates.filter(c => c.setup.zone === "OVERSOLD").length;
  log(`✅ [STK] Scan done in ${Math.round((scan.finishedAt - scan.startedAt) / 1000)}s — ${scan.ready} ready, ${scan.notReady} warm-up/stale, ${scan.failed.length} failed · candidates: ${os_} oversold, ${scan.candidates.length - os_} overbought`);
  if (scan.failed.length && scan.failed.length === syms.length) {
    scan.status = "error"; scan.error = `Every symbol failed — ${scan.failed[0].error} (expired Fyers token?)`;
    log(`❌ [STK] ${scan.error}`);
  }
}

// ── Quotes ───────────────────────────────────────────────────────────────────
/** Batch quote read → Map(fyersSym → v). Never throws. */
async function _quotes(fsyms) {
  const out = new Map();
  for (let i = 0; i < fsyms.length; i += QUOTE_BATCH) {
    const chunk = fsyms.slice(i, i + QUOTE_BATCH);
    try {
      const r = await fyers.getQuotes(chunk);
      if (r && r.s === "ok" && Array.isArray(r.d)) {
        for (const q of r.d) if (q && q.n && q.v && q.s !== "error") out.set(q.n, q.v);
      }
    } catch (e) {
      if (!_quotes._logged) { _quotes._logged = true; log(`⚠️ [STK] Quote read failed: ${e.message || e}`); setTimeout(() => { _quotes._logged = false; }, 30000); }
    }
  }
  return out;
}
function _lpOf(v) { const x = v && (v.lp || v.ltp); return engine._num(x) && x > 0 ? x : null; }

/** Candidates' official opens (quote open_price), refused on a prev-close mismatch. */
async function _fetchOpens(gen) {
  const pending = [...st.decisions.values()].filter(d => d.status === "waiting_open");
  if (!pending.length) { st._opensDone = true; return; }
  if (!st._firstOpenReadMs) st._firstOpenReadMs = Date.now();
  const q = await _quotes(pending.map(d => d.fyersSym));
  if (!st.running || gen !== _sessionGen) return;
  for (const d of pending) {
    const v = q.get(d.fyersSym);
    if (!v) continue;
    const op = v.open_price;
    const pc = v.prev_close_price;
    if (!engine._num(op) || !(op > 0)) continue;
    if (engine._num(pc) && pc > 0 && Math.abs(pc - d.setup.prevClose) / d.setup.prevClose > PREV_CLOSE_TOLERANCE) {
      d.status = "refused";
      d.note = `quote prev close ${pc} ≠ history close ${d.setup.prevClose} (> ${PREV_CLOSE_TOLERANCE * 100}%) — split / stale data`;
      skipLogger.appendSkipLog(MODE_KEY, { gate: "data", stock: d.stock, reason: d.note });
      continue;
    }
    d.open = op; d.openSrc = "quote open_price";
    d.signal = engine.getSignal({ setup: d.setup, todayOpen: op, cfg: _cfg(), prefix: PREFIX });
    if (d.signal.signal === "BUY_CE" || d.signal.signal === "BUY_PE") {
      d.status = "signal";
      log(`📈 [STK] SIGNAL ${d.stock} ${d.signal.side === "CE" ? "LONG" : "SHORT"} — RSI ${d.setup.prevRsi} (${d.setup.zone}) · prev close ₹${d.setup.prevClose} · open ₹${op} · gap ${d.signal.gapPts} pts (${d.signal.gapPct}%) · stop ₹${d.signal.slSpot}`);
    } else {
      d.status = "none";
      d.note = d.signal.reason;
      skipLogger.appendSkipLog(MODE_KEY, { gate: "strategy", stock: d.stock, skip: d.signal.skipReason, reason: d.signal.reason, prevRsi: d.setup.prevRsi, gapPts: d.signal.gapPts });
    }
  }
  // One illiquid stock with no open yet must not hold every other entry back.
  if (Date.now() - st._firstOpenReadMs >= OPEN_WAIT_MS) {
    for (const d of st.decisions.values()) {
      if (d.status !== "waiting_open") continue;
      d.status = "refused"; d.note = `no open price ${OPEN_WAIT_MS / 1000}s after the first read`;
      skipLogger.appendSkipLog(MODE_KEY, { gate: "data", stock: d.stock, reason: d.note });
    }
  }
  _saveDay();
  if (![...st.decisions.values()].some(d => d.status === "waiting_open")) {
    st._opensDone = true;
    const hits = [...st.decisions.values()].filter(d => d.status === "signal");
    const _cnt = {}; for (const d of st.decisions.values()) _cnt[d.status] = (_cnt[d.status] || 0) + 1;
    log(`📋 [STK] Opens known for every candidate — ${hits.length} signal(s) (biggest gap first): ${hits.sort((a, b) => Math.abs(b.signal.gapPct || 0) - Math.abs(a.signal.gapPct || 0)).map(h => `${h.stock} ${h.signal.side} gap ${h.signal.gapPct}%`).join(", ") || "none"} · ${Object.entries(_cnt).map(([k, v]) => `${k} ${v}`).join(" · ")}`);
  }
}

// ── Orders (simulated) ───────────────────────────────────────────────────────
function _slotsLeft() {
  return _maxTrades() - (st.sessionTrades.length + (st._priorTradesToday || 0)) - st.positions.size;
}

function _openPosition(d, price, spread) {
  const sig = d.signal;
  const qty = Math.floor(_tradeAmount() / price);
  if (!(qty >= 1)) {
    d.status = "skipped"; d.note = `price ₹${price} above the ₹${_tradeAmount()} trade amount`;
    return false;
  }
  // Capital gate — HARD: the Zerodha pool must fund qty × price or the stock is
  // skipped and its slot goes to the next candidate.
  const _cap = capitalPool.gate(MODE_KEY, qty * price, { side: sig.side, symbol: d.stock, qty });
  if (!_cap.ok) {
    d.status = "skipped"; d.note = _cap.reason;
    if (!_cap.muted) {
      log(`❌ [STK] ${d.stock} entry REFUSED — ${_cap.reason}`);
      skipLogger.appendSkipLog(MODE_KEY, { gate: "capital", stock: d.stock, reason: _cap.reason, qty, premium: price, cost: _cap.cost, available: _cap.available });
    }
    return;
  }
  const nowSec = Math.floor(Date.now() / 1000);
  const pos = {
    stock: d.stock, symbol: d.fyersSym, side: sig.side, direction: sig.side === "CE" ? "LONG" : "SHORT",
    qty, entryPrice: price, entryTime: istNow(), entryUnixSec: nowSec,
    stopLoss: sig.slSpot, initialStopLoss: sig.slSpot,
    prevDate: d.setup.prevDate, prevClose: d.setup.prevClose, prevRsi: d.setup.prevRsi, prevEma: d.setup.prevEma, rsiZone: d.setup.zone,
    todayOpen: d.open, gapPts: sig.gapPts, gapPct: sig.gapPct,
    reason: sig.reason, ltp: price, ltpAt: Date.now(), best: price, mfe: 0, mae: 0,
    lastTrailBarTime: null, trailEma: null, candlesHeld: 0,
    spreadAtEntry: spread ? spread.spread : null, peakPnl: 0, plArmed: false, beArmed: false,
  };
  st.positions.set(d.stock, pos);
  capitalPool.block(MODE_KEY, qty * price, { side: pos.side, symbol: d.stock, qty, premium: price }, { add: true });
  st._tradedToday.add(d.stock);
  d.status = "entered";
  d.note = `${pos.direction} ${qty} @ ₹${price}`;
  _savePositions();
  _trackStream(pos);
  const dir = pos.side === "CE" ? 1 : -1;
  const lv = (pct) => _r2(price * (1 + dir * pct / 100));
  log(`🎯 [STK] ENTRY ${pos.direction} ${qty} × ${d.stock} @ ₹${price} (₹${_r2(qty * price).toLocaleString("en-IN")}) | SL (prev close) ₹${pos.stopLoss} = risk ₹${_r2(Math.abs(price - pos.stopLoss) * qty)} | spread ${pos.spreadAtEntry != null ? pos.spreadAtEntry + "pt" : "n/a"} | RSI ${d.setup.prevRsi} · open ₹${d.open} · gap ${sig.gapPct}%`);
  log(`   [STK] ${d.stock} levels — breakeven ${_beOn() ? `arms at ₹${lv(_beArmPct())}` : "OFF"} · profit lock ${_plOn() ? `arms at ₹${lv(_plArmPct())}, floor ₹${lv(_plFloorPct())} (then trails)` : "OFF"} | ${sig.reason}`);
  notifyEntry({ mode: MODE_TAG, side: pos.side, symbol: d.fyersSym, spotAtEntry: price, stopLoss: pos.stopLoss, qty, reason: `${pos.direction} ${d.stock} — ${sig.reason}` });
  return true;
}

function _closePosition(stock, price, reason) {
  const pos = st.positions.get(stock);
  if (!pos) return;
  st.positions.delete(stock);
  try { optionFeed.release(`${SOCKET_CALLBACK_ID}:${stock}`); } catch (_) {}
  const dir = pos.side === "CE" ? 1 : -1;
  const gross = (price - pos.entryPrice) * dir * pos.qty;
  const charges = misCharges(pos.side, pos.entryPrice, price, pos.qty);
  const pnl = _r2(gross - charges);
  const trade = {
    stock: pos.stock, symbol: pos.symbol, side: pos.side, direction: pos.direction, qty: pos.qty,
    entryPrice: pos.entryPrice, exitPrice: price, spotAtEntry: pos.entryPrice, spotAtExit: price,
    entryTime: pos.entryTime, exitTime: istNow(),
    entryBarTime: pos.entryUnixSec, exitBarTime: Math.floor(Date.now() / 1000),
    durationMs: (Date.now() - pos.entryUnixSec * 1000),
    pnl, pnlPoints: _r2((price - pos.entryPrice) * dir), charges, pnlMode: "share price (MIS)",
    exitReason: reason, entryReason: pos.reason,
    stopLoss: pos.stopLoss, initialStopLoss: pos.initialStopLoss,
    prevDate: pos.prevDate, prevClose: pos.prevClose, prevRsi: pos.prevRsi, prevEma: pos.prevEma, rsiZone: pos.rsiZone,
    todayOpen: pos.todayOpen, gapPts: pos.gapPts, gapPct: pos.gapPct,
    trailEmaAtExit: pos.trailEma, candlesHeld: pos.candlesHeld,
    bestPrice: pos.best, mfePts: pos.mfe, maePts: pos.mae,
    peakPnl: pos.peakPnl, givenBack: _r2(pos.peakPnl - pnl),
    profitLockArmed: !!pos.plArmed, breakevenArmed: !!pos.beArmed, spreadAtEntry: pos.spreadAtEntry,
    instrument: "NSE_EQUITY_MIS", strategy: PREFIX,
  };
  st.sessionTrades.push(trade);
  tradeLogger.appendTradeLog(MODE_KEY, trade);
  st.sessionPnl = _r2(st.sessionPnl + pnl);
  capitalPool.release(MODE_KEY, pnl, { symbol: stock });   // frees this stock's block only
  if (pnl > 0) st.wins++; else st.losses++;
  const d = st.decisions.get(stock);
  if (d) { d.status = "exited"; d.note = `${reason} · ₹${pnl}`; }
  _savePositions();
  _saveDay();
  // Common wait-after-exit: no new entry for N trail candles.
  st._reentryBlockUntil = Math.max(st._reentryBlockUntil || 0, tradeGuards.reentryCooldownUntil(Date.now(), _cfg().EXIT_TF));
  log(`${pnl >= 0 ? "✅" : "❌"} [STK] EXIT ${pos.direction} ${pos.qty} × ${stock} @ ₹${price} | P&L ₹${pnl} (charges ₹${charges}) | ${reason}`);
  log(`   [STK] ${stock} summary — best ₹${pos.best} (peak P&L ₹${pos.peakPnl}, gave back ₹${trade.givenBack}) · MFE ${pos.mfe} / MAE ${pos.mae} pts · ${pos.candlesHeld} candles, ${Math.round(trade.durationMs / 60000)} min · lock ${pos.plArmed ? "armed" : "not armed"} · breakeven ${pos.beArmed ? "armed" : "not armed"} · session ₹${st.sessionPnl}`);
  notifyExit({ mode: MODE_TAG, side: pos.side, symbol: pos.symbol, spotAtEntry: pos.entryPrice, spotAtExit: price, pnl, sessionPnl: st.sessionPnl, exitReason: reason, entryReason: pos.reason, entryTime: pos.entryTime, exitTime: trade.exitTime, qty: pos.qty });
}

// ── Prices for held stocks ───────────────────────────────────────────────────
function _onPrice(stock, price, at) {
  const pos = st.positions.get(stock);
  if (!pos || !engine._num(price) || !(price > 0)) return;
  st.updates++;
  pos.ltp = price; pos.ltpAt = at || Date.now();
  const fav = (price - pos.entryPrice) * (pos.side === "CE" ? 1 : -1);
  if (fav > pos.mfe) pos.mfe = _r2(fav);
  if (fav < pos.mae) pos.mae = _r2(fav);
  if (pos.side === "CE" ? price > pos.best : price < pos.best) pos.best = price;
  pos.peakPnl = _r2(pos.mfe * pos.qty);
  // Gap stop — price back at yesterday's close.
  if (engine.stopHit(pos.side, price, pos.stopLoss)) {
    _closePosition(stock, price, `Gap stop — price ${price} back at prev close ${pos.stopLoss}`);
    return;
  }
  // Common profit lock, then breakeven — on the share price. The helpers are
  // written for a rising premium, so a short is fed the price mirrored around
  // its entry (a fall of x becomes a rise of x).
  const E = pos.entryPrice;
  const mir = (px) => (pos.side === "CE" ? px : 2 * E - px);
  const cur = mir(price), best = mir(pos.best);
  const gainPct = (best / E - 1) * 100;
  const floorPx = () => _r2(mir(tradeGuards.profitLockFloorLtp(E, best, _plFloorPct(), parseFloat(process.env.PROFIT_LOCK_TRAIL_PCT ?? "70"))));
  if (!pos.beArmed && _beOn() && gainPct >= _beArmPct()) {
    pos.beArmed = true;
    log(`🛡️ [STK] ${stock} breakeven ARMED — best ₹${pos.best} (+${_r2(gainPct)}%, ₹${pos.peakPnl}) · exit if price returns to entry ₹${E}`);
  }
  if (!pos.plArmed && _plOn() && gainPct >= _plArmPct()) {
    pos.plArmed = true;
    log(`🔒 [STK] ${stock} profit lock ARMED — best ₹${pos.best} (+${_r2(gainPct)}%, ₹${pos.peakPnl}) · floor now ₹${floorPx()}, rises with the best price`);
  }
  const pl = tradeGuards.checkProfitLock(E, cur, best);
  if (pl) {
    _closePosition(stock, price, `Profit lock — price ${price} hit the floor ${floorPx()} (best ${pos.best}, entry ${E}, armed at +${_plArmPct()}%)`);
    return;
  }
  if (tradeGuards.checkBreakevenStop(E, cur, best)) {
    _closePosition(stock, price, `Breakeven stop — price ${price} back to entry ${E} (best ${pos.best}, armed at +${_beArmPct()}%)`);
  }
}
function _trackStream(pos) {
  try { optionFeed.track(`${SOCKET_CALLBACK_ID}:${pos.stock}`, pos.symbol, (ltp, at) => { if (st.running) _onPrice(pos.stock, ltp, at); }); } catch (_) {}
}

async function _pollHeld(gen) {
  const held = [...st.positions.values()];
  if (!held.length) return;
  for (const p of held) _trackStream(p);   // renews the stream lease
  const stale = held.filter(p => { const f = optionFeed.getFresh(p.symbol); return !f; });
  if (!stale.length) return;
  const q = await _quotes(stale.map(p => p.symbol));
  if (!st.running || gen !== _sessionGen) return;
  for (const p of stale) { const lp = _lpOf(q.get(p.symbol)); if (lp) _onPrice(p.stock, lp, Date.now()); }
}

// ── Trailing EMA on closed exit-TF candles ───────────────────────────────────
async function _checkTrail(gen) {
  const cfg = _cfg();
  const nowSec = Math.floor(Date.now() / 1000);
  const tfSec = cfg.EXIT_TF * 60;
  for (const pos of [...st.positions.values()]) {
    let bars;
    try { bars = await swingScanner.fetchSeries(pos.symbol, String(cfg.EXIT_TF), _daysAgoStr(7), _todayStr()); }
    catch (e) { log(`⚠️ [STK] ${pos.stock} ${cfg.EXIT_TF}-min history failed: ${e.message || e} — trail check skipped this bar (gap stop still active)`); continue; }
    if (!st.running || gen !== _sessionGen || !st.positions.has(pos.stock)) continue;
    const closed = (bars || []).filter(b => b.time + tfSec <= nowSec);
    if (!closed.length) continue;
    const ema = engine.computeTrailEma(closed, cfg);
    // Every closed candle not yet tested, oldest first — a bar Fyers published
    // late, or a fetch that failed, is caught on the next check instead of skipped.
    for (let i = 0; i < closed.length; i++) {
      const bar = closed[i];
      if (engine._num(pos.lastTrailBarTime) && bar.time <= pos.lastTrailBarTime) continue;
      pos.lastTrailBarTime = bar.time;
      // Only candles that CLOSED after the entry.
      if (bar.time + tfSec <= pos.entryUnixSec) continue;
      pos.candlesHeld++;
      pos.trailEma = engine._num(ema[i]) ? _r2(ema[i]) : null;
      const ex = engine.trailExit(pos.side, bar, ema[i], cfg);
      const dir = pos.side === "CE" ? 1 : -1;
      const px = pos.ltp || bar.close;
      log(`📊 [STK] ${pos.stock} ${cfg.EXIT_TF}m ${engine._fmtMins(engine._istMins(bar.time))} O ${bar.open} H ${bar.high} L ${bar.low} C ${bar.close} · EMA${cfg.TRAIL_EMA_LENGTH} ${pos.trailEma ?? "n/a"} (${pos.trailEma != null ? _r2((bar.close - pos.trailEma) * dir) : "?"} pts room) · ${ex.exit ? "EXIT" : "hold"} · LTP ₹${px} · open P&L ₹${_r2((px - pos.entryPrice) * dir * pos.qty)} · best ₹${pos.best} (peak ₹${pos.peakPnl})`);
      if (ex.exit) {
        _closePosition(pos.stock, pos.ltp || bar.close, `EMA trail — ${ex.reason}`);
        break;
      }
    }
  }
}

// ── The loop ─────────────────────────────────────────────────────────────────
function _loop() {
  if (!st.running) return;
  const gen = _sessionGen;
  const cfg = _cfg();
  const nowMs = Date.now();
  const nowSec = Math.floor(nowMs / 1000);
  const mins = engine._istMins(nowSec);

  // EOD square-off — every position, then the day is over.
  if (engine.isEodExit(nowSec, cfg)) {
    for (const p of [...st.positions.values()]) _closePosition(p.stock, p.ltp || p.entryPrice, `EOD square-off ${engine._fmtMins(cfg.EOD_EXIT)}`);
    if (!st._dayDone) { st._dayDone = true; st._dayDoneReason = `past the ${engine._fmtMins(cfg.EOD_EXIT)} square-off`; }
    if (mins >= _stopMins()) { _stopSession("⏰ Auto-stop — market closed"); }
    return;
  }

  // Prices for held stocks (stream-first, REST fallback).
  if (st.positions.size && !_busy.quotes && nowMs - _lastQuoteMs >= QUOTE_POLL_MS) {
    _busy.quotes = true; _lastQuoteMs = nowMs;
    _pollHeld(gen).catch(e => log(`⚠️ [STK] price poll error: ${e.message}`)).finally(() => { _busy.quotes = false; });
  }
  // Trail check just after each exit-TF close.
  const tfSec = cfg.EXIT_TF * 60;
  const sinceClose = (nowSec + 19800) % tfSec;
  if (st.positions.size && !_busy.trail && sinceClose >= TRAIL_FETCH_LAG_S && sinceClose < TRAIL_FETCH_LAG_S + 30) {
    const barKey = nowSec - sinceClose;
    if (st._lastTrailKey !== barKey) {
      st._lastTrailKey = barKey;
      _busy.trail = true;
      _checkTrail(gen).catch(e => log(`⚠️ [STK] trail check error: ${e.message}`)).finally(() => { _busy.trail = false; });
    }
  }

  // ── Entries (inside the window only) ──
  if (st._dayDone) return;
  if (mins < cfg.ENTRY_START) return;
  if (!engine.isInEntryWindow(nowSec, cfg)) {
    const waiting = [...st.decisions.values()].filter(d => d.status === "waiting_open" || d.status === "signal");
    for (const d of waiting) { d.status = "missed"; d.note = `entry window ${engine._fmtMins(cfg.ENTRY_START)}–${engine._fmtMins(cfg.ENTRY_END)} closed`; }
    st._dayDone = true;
    st._dayDoneReason = `entry window closed${st.scan.status !== "done" ? ` before the scan finished (${st.scan.done}/${st.scan.total})` : ""}`;
    _saveDay();
    log(`⏭️ [STK] Entries closed for today — ${st._dayDoneReason}. Open positions: ${st.positions.size}.`);
    return;
  }
  if (st.scan.status !== "done") return;
  if (!st._opensDone) {
    if (!_busy.opens && nowMs - _lastOpenMs >= OPEN_POLL_MS) {
      _busy.opens = true; _lastOpenMs = nowMs;
      _fetchOpens(gen).catch(e => log(`⚠️ [STK] open read error: ${e.message}`)).finally(() => { _busy.opens = false; });
    }
    // Fill what is already known only once EVERY open is in, so the ranking is
    // over the whole list, not whichever quotes came back first.
    return;
  }
  if (_busy.entry) return;
  if (_slotsLeft() <= 0) return;
  // Common wait-after-exit and portfolio daily cap — both only hold entries.
  if (nowMs < (st._reentryBlockUntil || 0)) {
    if (st._cooldownLogged !== st._reentryBlockUntil) { st._cooldownLogged = st._reentryBlockUntil; log(`⏸️ [STK] Wait after exit — no new entry until ${new Date(st._reentryBlockUntil + 19800000).toISOString().slice(11, 19)}`); }
    return;
  }
  const pf = portfolioRisk.checkPortfolioCap();
  if (pf.blocked) {
    if (!st._pfLogged) { st._pfLogged = true; log(`⛔ [STK] Entries held — ${pf.reason}`); skipLogger.appendSkipLog(MODE_KEY, { gate: "portfolio", reason: pf.reason }); }
    return;
  }
  const ready = [...st.decisions.values()]
    .filter(d => d.status === "signal" && !st._tradedToday.has(d.stock))
    .sort((a, b) => Math.abs(b.signal.gapPct || 0) - Math.abs(a.signal.gapPct || 0));
  if (!ready.length) {
    if (!st.positions.size || _slotsLeft() > 0) {
      const anyLeft = [...st.decisions.values()].some(d => d.status === "signal");
      if (!anyLeft && !st._entriesLogged) { st._entriesLogged = true; log(`ℹ️ [STK] No more signals to fill today (${st.sessionTrades.length + st.positions.size + (st._priorTradesToday || 0)}/${_maxTrades()} used).`); }
    }
    return;
  }
  // Synchronous guard before the first await — one fill batch at a time.
  _busy.entry = true;
  (async () => {
    const q = await _quotes(ready.map(d => d.fyersSym));
    if (!st.running || gen !== _sessionGen) return;
    let held = 0;   // slots kept for bigger gaps still waiting for a price
    for (const d of ready) {
      if (_slotsLeft() - held <= 0) break;
      if (st.positions.has(d.stock) || st._tradedToday.has(d.stock)) continue;
      const lp = _lpOf(q.get(d.fyersSym));
      if (!lp) {
        if (!d.noLpSince) d.noLpSince = Date.now();
        if (Date.now() - d.noLpSince >= OPEN_WAIT_MS) {
          d.status = "skipped"; d.note = `no live price ${OPEN_WAIT_MS / 1000}s after its signal — slot released`;
          skipLogger.appendSkipLog(MODE_KEY, { gate: "data", stock: d.stock, reason: d.note });
          continue;
        }
        d.note = "no live price yet — retrying (its slot is held)";
        held++;
        continue;
      }
      if (!engine.entryStillValid(d.signal.side, lp, d.signal.slSpot)) {
        d.status = "skipped";
        d.note = `price ₹${lp} already filled the gap (prev close ₹${d.signal.slSpot})`;
        log(`⏭️ [STK] ${d.stock} ${d.signal.signal} skipped — ${d.note}`);
        skipLogger.appendSkipLog(MODE_KEY, { gate: "strategy", stock: d.stock, reason: d.note, signal: d.signal.signal });
        continue;
      }
      // Common bid-ask spread check (fails open when the quote has no depth).
      const qv = q.get(d.fyersSym) || {};
      const sp = tradeGuards.checkSpread(Number(qv.bid || qv.bid_price || 0), Number(qv.ask || qv.ask_price || 0));
      if (!sp.ok) {
        d.status = "skipped";
        d.note = `spread too wide — ${sp.reason}`;
        log(`⏭️ [STK] ${d.stock} ${d.signal.signal} skipped — ${d.note}`);
        skipLogger.appendSkipLog(MODE_KEY, { gate: "spread", stock: d.stock, reason: sp.reason, bid: qv.bid, ask: qv.ask, ltp: lp });
        continue;
      }
      _openPosition(d, lp, sp);
    }
    _saveDay();
  })().catch(e => log(`⚠️ [STK] entry error: ${e.message}`)).finally(() => { _busy.entry = false; });
}

// ── Session lifecycle ────────────────────────────────────────────────────────
function _saveSession() {
  const data = loadPaperData();
  const session = {
    date: _todayStr(), strategy: PREFIX, instrument: "NSE_EQUITY_MIS",
    startTime: st.sessionStart, endTime: istNow(),
    trades: st.sessionTrades, totalTrades: st.sessionTrades.length,
    wins: st.wins, losses: st.losses,
    winRate: st.sessionTrades.length ? `${((st.wins / st.sessionTrades.length) * 100).toFixed(1)}%` : "N/A",
    sessionPnl: st.sessionPnl,
    scan: { universe: st.scan.universe, total: st.scan.total, ready: st.scan.ready, candidates: st.scan.candidates.length, failed: st.scan.failed.length },
  };
  data.sessions.push(session);
  data.totalPnl = _r2(data.totalPnl + st.sessionPnl);
  data.capital  = _r2(data.capital + st.sessionPnl);
  savePaperData(data);
  capitalPool.sessionSaved(MODE_KEY);
  log(`💾 [STK] Session saved. Capital ₹${data.capital} | Total PnL ₹${data.totalPnl}`);
  if (canSend("TG_GAP_RUNAWAY_STK_DAYREPORT")) {
    sendTelegram([
      `📄 ${LABEL} PAPER — DAY REPORT`,
      `📅 ${_todayStr()}`,
      ``,
      `Scanned ${st.scan.total} · candidates ${st.scan.candidates.length}`,
      `Trades ${st.sessionTrades.length} (${st.wins}W / ${st.losses}L) · P&L ₹${st.sessionPnl}`,
      ...st.sessionTrades.map(t => `${t.direction} ${t.stock} gap ${t.gapPct}% · ₹${t.pnl} · ${t.exitReason}`),
    ].join("\n"));
  }
  return session;
}

function _stopSession(reason) {
  if (!st.running) return null;
  for (const p of [...st.positions.values()]) _closePosition(p.stock, p.ltp || p.entryPrice, reason || "Manual stop");
  st.running = false;
  _sessionGen++;
  if (_loopTimer) { clearInterval(_loopTimer); _loopTimer = null; }
  if (_autoStopTimer) { clearTimeout(_autoStopTimer); _autoStopTimer = null; }
  socketManager.removeCallback(SOCKET_CALLBACK_ID);
  sharedSocketState.clearGapRunawayStkMode();
  if (!sharedSocketState.isAnyActive() && socketManager.isRunning()) socketManager.stop();
  log(`⏹ [STK] Stopped — ${reason || "manual"}`);
  return _saveSession();
}

router.get("/start", async (req, res) => {
  if (st.running) return res.status(400).json({ success: false, error: "Already running." });
  if (String(process.env.GAP_RUNAWAY_STK_MODE_ENABLED || "true").toLowerCase() !== "true") {
    return res.status(403).json({ success: false, error: `${LABEL} is disabled. Enable it in Settings first.` });
  }
  const auth = await verifyFyersToken();
  if (!auth.ok) return res.status(401).json({ success: false, error: auth.message, code: auth.code });
  const gate = sharedSocketState.canStart("GAP_RUNAWAY_STK_PAPER");
  if (!gate.allowed) return res.status(400).json({ success: false, error: `Cannot start — ${gate.reason}` });
  const tc = await isTradingAllowed();
  if (!tc.allowed) return res.status(400).json({ success: false, error: `❌ ${tc.reason}` });
  if (_nowMins() >= _stopMins()) return res.status(400).json({ success: false, error: "Trading session closed for today. Restart tomorrow." });
  if (st.running) return res.status(400).json({ success: false, error: "Already running." });

  const cfg = _cfg();
  const todayStr = _todayStr();
  _sessionGen++;
  const gen = _sessionGen;
  st.running = true;
  st.sessionStart = istNow();
  st.log = [];
  st.scan = _freshScan();
  st.decisions = new Map();
  st._opensDone = false;
  st._firstOpenReadMs = 0;
  st.positions = new Map();
  st.sessionTrades = [];
  st.sessionPnl = 0; st.wins = 0; st.losses = 0;
  st._staleSession = false;
  st._dayDone = false; st._dayDoneReason = null; st._entriesLogged = false; st._lastTrailKey = null;
  st._reentryBlockUntil = 0; st._cooldownLogged = 0; st._pfLogged = false;
  st.updates = 0;
  st._tradedToday = new Set();
  st._priorTradesToday = 0;
  _busy = { quotes: false, opens: false, trail: false, entry: false };

  // Restart recovery: today's earlier trades count toward the cap, and their
  // stocks are not traded again; today's still-open paper positions resume.
  try {
    const data = loadPaperData();
    const keyOf = (t) => String(t.entryTime || "") + "|" + String(t.stock || "");
    const savedKeys = new Set();
    for (const s of (data.sessions || [])) {
      for (const t of (s.trades || [])) {
        savedKeys.add(keyOf(t));
        if (String(s.date || "").slice(0, 10) === todayStr) { st._priorTradesToday++; if (t.stock) st._tradedToday.add(t.stock); }
      }
    }
    for (const t of tradeLogger.readDailyTrades(MODE_KEY, todayStr)) {
      if (!t || t.type || !t.stock || savedKeys.has(keyOf(t))) continue;
      st._priorTradesToday++; st._tradedToday.add(t.stock);
    }
    for (const p of _loadPositions()) {
      st.positions.set(p.stock, Object.assign(p, { ltp: p.entryPrice, ltpAt: 0 }));
      capitalPool.block(MODE_KEY, p.qty * p.entryPrice, { side: p.side, symbol: p.stock, qty: p.qty, premium: p.entryPrice }, { add: true });
      st._tradedToday.add(p.stock);
    }
    if (st._priorTradesToday || st.positions.size) {
      log(`♻️ [STK] Restart recovery — ${st._priorTradesToday} trade(s) closed earlier today, ${st.positions.size} open position(s) resumed: ${[...st.positions.keys()].join(", ") || "none"}`);
    }
  } catch (e) { log(`⚠️ [STK] restart recovery failed: ${e.message}`); }
  if (_nowMins() > cfg.ENTRY_END) {
    st._dayDone = true;
    st._dayDoneReason = `started after the ${engine._fmtMins(cfg.ENTRY_END)} entry cut-off — no new trades today`;
  }
  // Decisions already settled earlier today stand (see DAY_FILE).
  const _day = _loadDay();
  st._dayFinal = _day ? (_day.final || {}) : {};
  if (_day && _day.dayDone && !st._dayDone) { st._dayDone = true; st._dayDoneReason = `${_day.dayDone} (decided earlier today)`; }

  log(`════════════════════════════════════════════════════════════════════`);
  log(`🟡 [STK] ${LABEL} paper started — ${engine.referenceUrl(PREFIX)}`);
  log(`   Universe  : ${_universeKey()} · ₹${_tradeAmount().toLocaleString("en-IN")} per trade · max ${_maxTrades()} trades/day · intraday shares (MIS)`);
  log(`   Setup     : daily RSI(${cfg.RSI_LENGTH}) on EMA(${cfg.EMA_LENGTH}) of yesterday — < ${cfg.RSI_LOWER} oversold → gap UP = BUY · > ${cfg.RSI_UPPER} overbought → gap DOWN = SHORT`);
  log(`   Exit      : gap stop = prev close · ${cfg.EXIT_TF}-min close through EMA${cfg.TRAIL_EMA_LENGTH} · square-off ${engine._fmtMins(cfg.EOD_EXIT)} · window ${engine._fmtMins(cfg.ENTRY_START)}–${engine._fmtMins(cfg.ENTRY_END)}`);
  const _onOff = (k) => String(process.env[k] ?? "true").toLowerCase() !== "false" ? "on" : "OFF";
  log(`   Common    : profit lock ${_onOff("PROFIT_LOCK_ENABLED")} (arm +${_plArmPct()}% / floor +${_plFloorPct()}% of the share price, trail keeps ${process.env.PROFIT_LOCK_TRAIL_PCT ?? "70"}% · tiers ${process.env.PROFIT_LOCK_TRAIL_TIERS ?? "20:85,40:80"}) · breakeven ${_onOff("BREAKEVEN_STOP_ENABLED")} (arm +${_beArmPct()}%)`);
  log(`              wait-after-exit ${tradeGuards.reentryCooldownMs(cfg.EXIT_TF) / 60000} min · spread check ${_onOff("MAX_BID_ASK_SPREAD_ENABLED")} (max ${process.env.MAX_BID_ASK_SPREAD_PTS || "2"} pts) · portfolio cap ${portfolioRisk.checkPortfolioCap().disabled ? "OFF" : "on"} · trade window 10:00–14:00 NOT applied (09:15 gap rule)`);
  if (st._dayDone) log(`   Today     : ${st._dayDoneReason}`);
  log(`════════════════════════════════════════════════════════════════════`);

  // The shared socket carries the held stocks' streams; NIFTY is only its anchor.
  if (!socketManager.isRunning()) socketManager.start(NIFTY_INDEX_SYMBOL, () => {}, log);
  socketManager.addCallback(SOCKET_CALLBACK_ID, () => {}, log, NIFTY_INDEX_SYMBOL);
  sharedSocketState.setGapRunawayStkMode("GAP_RUNAWAY_STK_PAPER");
  for (const p of st.positions.values()) _trackStream(p);

  _loopTimer = setInterval(() => { try { _loop(); } catch (e) { console.error(`[GAP_RUNAWAY_STK-PAPER] loop error: ${e.stack || e.message}`); } }, LOOP_MS);
  // Auto-stop at TRADE_STOP_TIME (the loop also does it).
  const msToStop = (_stopMins() - _nowMins()) * 60000 - (Date.now() % 60000);
  if (msToStop > 0) _autoStopTimer = setTimeout(() => _stopSession("⏰ Auto-stop — market closed"), msToStop);

  notifyStarted({ mode: MODE_TAG, text: [`✅ ${LABEL} PAPER — STARTED`, ``, `Universe ${_universeKey()} · ₹${_tradeAmount()} per trade · max ${_maxTrades()}/day`, st._dayDone ? `ℹ️ ${st._dayDoneReason}` : `Scanning now — entries ${engine._fmtMins(cfg.ENTRY_START)}–${engine._fmtMins(cfg.ENTRY_END)}`].join("\n") });

  // The scan runs in the background — it takes ~1-2 min for the F&O list.
  if (!st._dayDone) _runScan(gen).catch(e => { st.scan.status = "error"; st.scan.error = e.message; log(`❌ [STK] Scan failed: ${e.message}`); });
  else st.scan.status = "skipped";

  return res.json({ success: true, message: "Stock scanner paper trading started. No real orders will be placed.", universe: _universeKey(), dayDone: st._dayDone ? st._dayDoneReason : null, monitorAt: "GET /gap_runaway_stk-paper/status" });
});

router.get("/stop", (req, res) => {
  if (!st.running) return res.status(400).json({ success: false, error: "Not running." });
  const session = _stopSession("Manual stop");
  return res.json({ success: true, message: "Stopped. Session saved.", session });
});

/** GET /exit?stock=RELIANCE — exit one position; no stock = exit all. Session keeps running. */
router.get("/exit", (req, res) => {
  if (!st.running) return res.status(400).json({ success: false, error: "Not running." });
  // ?stock= from this page, ?symbol= from the Real-Time monitor's per-row EXIT.
  const one = String((req.query && (req.query.stock || req.query.symbol)) || "").trim().toUpperCase();
  const list = one ? [st.positions.get(one)].filter(Boolean) : [...st.positions.values()];
  if (!list.length) return res.status(400).json({ success: false, error: one ? `No open position in ${one}.` : "No open positions." });
  for (const p of list) _closePosition(p.stock, p.ltp || p.entryPrice, "Manual exit by user");
  return res.json({ success: true, exited: list.map(p => p.stock) });
});

// ── JSON feed ────────────────────────────────────────────────────────────────
function _statusPayload() {
  const data = loadPaperData();
  const cfg = _cfg();
  const positions = [...st.positions.values()].map(p => {
    const dir = p.side === "CE" ? 1 : -1;
    const px = p.ltp || p.entryPrice;
    const pnl = _r2((px - p.entryPrice) * dir * p.qty - misCharges(p.side, p.entryPrice, px, p.qty));
    // symbol / side LONG|SHORT / livePnl are the cash-equity row shape the
    // Real-Time monitor's multi-position card reads (same as EarlyBird's).
    return {
      stock: p.stock, symbol: p.stock, direction: p.direction, side: p.direction, signalSide: p.side, qty: p.qty,
      entryPrice: p.entryPrice, entryTime: p.entryTime,
      ltp: px, stopLoss: p.stopLoss, trailEma: p.trailEma, gapPct: p.gapPct, prevRsi: p.prevRsi,
      pnl, livePnl: pnl,
    };
  });
  const unrealised = _r2(positions.reduce((s, p) => s + p.pnl, 0));
  const decisions = [...st.decisions.values()].map(d => ({
    stock: d.stock, zone: d.setup.zone, prevRsi: d.setup.prevRsi, prevClose: d.setup.prevClose, prevDate: d.setup.prevDate,
    open: d.open, gapPts: d.signal ? d.signal.gapPts : null, gapPct: d.signal ? d.signal.gapPct : null,
    signal: d.signal ? d.signal.signal : null, status: d.status, note: d.note,
  })).sort((a, b) => Math.abs(b.gapPct || 0) - Math.abs(a.gapPct || 0) || a.stock.localeCompare(b.stock));
  return {
    running: st.running, label: LABEL, sessionStart: st.sessionStart,
    sessionPnl: st.sessionPnl, unrealisedPnl: unrealised, staleSession: st._staleSession,
    capital: data.capital, totalPnl: data.totalPnl, startCapital: getCapitalFromEnv(),
    tradeCount: st.sessionTrades.length, wins: st.sessionTrades.filter(t => Number(t.pnl) > 0).length, losses: st.sessionTrades.filter(t => Number(t.pnl) <= 0).length,
    priorTradesToday: st._priorTradesToday, maxTrades: _maxTrades(), tradeAmount: _tradeAmount(),
    dayDone: st._dayDone ? st._dayDoneReason : null,
    updates: st.updates,
    config: { rsiLen: cfg.RSI_LENGTH, emaLen: cfg.EMA_LENGTH, rsiLower: cfg.RSI_LOWER, rsiUpper: cfg.RSI_UPPER, minGap: cfg.MIN_GAP_PTS,
              window: `${engine._fmtMins(cfg.ENTRY_START)}–${engine._fmtMins(cfg.ENTRY_END)}`, eod: engine._fmtMins(cfg.EOD_EXIT), exitTf: cfg.EXIT_TF, trailLen: cfg.TRAIL_EMA_LENGTH, universe: _universeKey(),
              common: `profit lock ${_plOn() ? `+${_plArmPct()}% → floor +${_plFloorPct()}% (trails)` : "off"} · breakeven ${_beOn() ? `at +${_beArmPct()}%` : "off"} · wait ${tradeGuards.reentryCooldownMs(cfg.EXIT_TF) / 60000} min after exit · spread check · portfolio cap` },
    scan: { status: st.scan.status, universe: st.scan.universe, total: st.scan.total, done: st.scan.done, ready: st.scan.ready, notReady: st.scan.notReady,
            failed: st.scan.failed.length, failedSample: st.scan.failed.slice(0, 5), candidates: st.scan.candidates.length, error: st.scan.error },
    decisions, positions,
    trades: st.sessionTrades.map(t => ({ stock: t.stock, direction: t.direction, side: t.side, qty: t.qty, entryPrice: t.entryPrice, exitPrice: t.exitPrice, entryTime: t.entryTime, exitTime: t.exitTime, pnl: t.pnl, charges: t.charges, reason: t.exitReason, gapPct: t.gapPct, prevRsi: t.prevRsi })),
    reference: engine.referenceUrl(PREFIX),
    logs: st.log.slice(-150).reverse(),
  };
}
/** The whole in-memory activity log, oldest first — what the Copy Log button copies. */
router.get("/logs", (req, res) => {
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  return res.send(st.log.join("\n") || "No log yet.");
});
router.get("/status/data", (req, res) => {
  try { return res.json(_statusPayload()); }
  catch (e) { return res.status(500).json({ error: e.message }); }
});

// ── Status page (same look as /ema_rsi_st-paper; rendered client-side from /status/data) ──
router.get("/status", (req, res) => {
  let payload;
  try { payload = _statusPayload(); } catch (e) { return res.status(500).send(e.message); }
  const liveActive = false;
  res.setHeader("Content-Type", "text/html");
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"/>
  <title>ௐ Palani Andawar Thunai ॐ — ${LABEL} Paper</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;600&display=swap" rel="stylesheet"/>
  <style>
    *{box-sizing:border-box;margin:0;padding:0;}
    body{font-family:'Inter',sans-serif;background:#060e06;color:#c0d8b0;overflow-x:hidden;}
${sidebarCSS()}
${modalCSS()}
    .page{padding:22px 20px 60px;}
    .capital-strip{display:flex;background:#090f09;border:0.5px solid #162416;border-radius:9px;overflow:hidden;margin-bottom:14px;}
    .cap-cell{flex:1;padding:11px 16px;border-right:0.5px solid #162416;}
    .cap-cell:last-child{border-right:none;}
    .cap-label{font-size:0.56rem;text-transform:uppercase;letter-spacing:1.5px;color:#7f9b5c;margin-bottom:4px;}
    .cap-val{font-size:1rem;font-weight:700;font-family:'IBM Plex Mono',monospace;color:#a0c880;}
    .stat-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:9px;margin-bottom:16px;}
    .sc{background:#090f09;border:0.5px solid #162416;border-radius:8px;padding:12px 14px;position:relative;overflow:hidden;border-top:1.5px solid #2a4020;}
    .sc-label{font-size:0.56rem;text-transform:uppercase;letter-spacing:1.2px;color:#7f9b5c;margin-bottom:5px;}
    .sc-val{font-size:1rem;font-weight:700;font-family:'IBM Plex Mono',monospace;color:#c0d8b0;}
    .sc-sub{font-size:0.62rem;color:#7f9b5c;margin-top:4px;line-height:1.4;word-break:break-word;}
    .section-title{font-size:0.58rem;font-weight:700;text-transform:uppercase;letter-spacing:2px;color:#7f9b5c;margin:18px 0 8px;display:flex;align-items:center;gap:8px;}
    .section-title::after{content:'';flex:1;height:0.5px;background:#162416;}
    .card{background:#090f09;border:0.5px solid #162416;border-radius:10px;padding:12px 14px;}
    .tbl-wrap{border:1px solid #1a2236;border-radius:10px;overflow-x:auto;-webkit-overflow-scrolling:touch;}
    table{width:100%;border-collapse:collapse;font-size:0.74rem;}
    th{padding:8px 10px;text-align:left;font-size:0.58rem;text-transform:uppercase;letter-spacing:1px;color:#8ba1c2;background:#0a0f1c;white-space:nowrap;}
    td{padding:8px 10px;border-top:1px solid #1a2236;font-family:'IBM Plex Mono',monospace;white-space:nowrap;}
    td.wrap{white-space:normal;min-width:180px;font-family:'Inter',sans-serif;color:#8ba1c2;}
    .pos{color:#10b981;} .neg{color:#ef4444;} .mut{color:#8ba1c2;} .amb{color:#f59e0b;}
    .btn{background:#7f1d1d;border:1px solid #ef4444;color:#fca5a5;font-size:0.72rem;font-weight:700;padding:8px 14px;border-radius:7px;cursor:pointer;font-family:inherit;min-height:44px;min-width:64px;}
    .note{font-size:0.66rem;color:#7f9b5c;line-height:1.5;margin-top:6px;word-break:break-word;}
    .logbox{background:#060b06;border:1px solid #162416;border-radius:10px;padding:10px 12px;max-height:340px;overflow:auto;font-family:'IBM Plex Mono',monospace;font-size:0.66rem;line-height:1.55;color:#a0b8a0;white-space:pre-wrap;word-break:break-word;}
    .copy-btn{margin-left:auto;background:#0d1320;border:1px solid #1a2236;color:#4a9cf5;padding:6px 12px;border-radius:6px;font-size:0.68rem;cursor:pointer;font-family:inherit;min-height:44px;letter-spacing:0;text-transform:none;font-weight:600;}
    .copy-btn.copied{background:#064e3b;border-color:#10b981;color:#34d399;}
    .bar{height:6px;background:#162416;border-radius:4px;overflow:hidden;margin-top:6px;} .bar>i{display:block;height:100%;background:#10b981;}
    @media(max-width:640px){
      .page{padding:14px 12px calc(40px + env(safe-area-inset-bottom));}
      .stat-grid{grid-template-columns:1fr 1fr;gap:7px;}
      .capital-strip{flex-wrap:wrap;}
      .cap-cell{min-width:50%;}
    }
  </style>
</head>
<body>
<div class="app-shell">
${buildSidebar('gapRunawayStkPaper', liveActive, st.running, {
  showExitBtn:  st.positions.size > 0,
  showStopBtn:  st.running,
  showStartBtn: !st.running,
  exitBtnJs:    'grExit(this, "")',
  stopBtnJs:    'grStop(this)',
  startBtnJs:   'grStart(this)',
  exitLabel:    '🚪 Exit All',
  stopLabel:    '■ Stop Paper',
  startLabel:   '▶ Start Paper',
})}
<div class="main-content">
  <div class="top-bar">
    <div>
      <div class="top-bar-title">📋 Stock Scanner — Paper</div>
      <div class="top-bar-meta">Strategy: ${LABEL} · intraday shares (MIS) · ${st.running ? 'Auto-refreshes every 2s' : 'Stopped'}</div>
    </div>
    <div class="top-bar-right">
      ${st.running ? '<span class="top-bar-badge paper-active"><span style="width:5px;height:5px;border-radius:50%;background:#10b981;display:inline-block;"></span>RUNNING</span>' : '<span class="top-bar-badge">● IDLE</span>'}
      <a href="/gap_runaway_stk-paper/history" style="background:rgba(59,130,246,0.08);border:0.5px solid rgba(59,130,246,0.3);color:#60a5fa;padding:5px 11px;border-radius:6px;font-size:0.68rem;font-weight:600;text-decoration:none;">📊 History</a>
      <button onclick="grReset(this)" style="background:#07111f;border:0.5px solid #0e1e36;color:#8ba1c2;padding:5px 11px;border-radius:6px;font-size:0.68rem;font-weight:600;cursor:pointer;font-family:inherit;">↺ Reset</button>
    </div>
  </div>
  <div class="page">
    <div id="gr-root"></div>
    <div class="section-title">Activity Log (latest 150 — Copy Log copies all) <button class="copy-btn" onclick="grCopyLog(this)">📋 Copy Log</button></div>
    <div class="logbox" id="gr-log"></div>
  </div>
</div>
</div>
<script id="gr-data" type="application/json">${JSON.stringify(payload).replace(/</g, "\\u003c")}</script>
<script>
${modalJS()}
function esc(s){ return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function inr(n){ return typeof n === 'number' ? '\\u20b9' + n.toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2}) : '\\u2014'; }
function cls(n){ return n > 0 ? 'pos' : n < 0 ? 'neg' : 'mut'; }
var STATUS = { waiting_open:['waiting for open','mut'], signal:['SIGNAL — filling','amb'], none:['no trade','mut'], entered:['IN TRADE','pos'], exited:['exited','mut'], skipped:['skipped','amb'], missed:['missed','amb'], refused:['refused','neg'] };
function render(d){
  var h = '';
  h += '<div class="capital-strip">'
    + '<div class="cap-cell"><div class="cap-label">Starting Capital</div><div class="cap-val">' + inr(d.startCapital) + '</div></div>'
    + '<div class="cap-cell"><div class="cap-label">Current Capital</div><div class="cap-val ' + (d.capital >= d.startCapital ? 'pos' : 'neg') + '">' + inr(d.capital) + '</div></div>'
    + '<div class="cap-cell"><div class="cap-label">All-Time PnL</div><div class="cap-val ' + cls(d.totalPnl) + '">' + inr(d.totalPnl) + '</div></div>'
    + '<div class="cap-cell" style="font-size:0.62rem;color:#7f9b5c;max-width:200px;line-height:1.5;display:flex;align-items:center;">Paper only — no real orders. ' + inr(d.tradeAmount) + ' per trade.</div></div>';
  var sc = d.scan, pct = sc.total ? Math.round(sc.done / sc.total * 100) : 0;
  h += '<div class="stat-grid">'
    + '<div class="sc"><div class="sc-label">Session PnL</div><div class="sc-val ' + cls(d.sessionPnl) + '">' + inr(d.sessionPnl) + '</div><div class="sc-sub">open: <span class="' + cls(d.unrealisedPnl) + '">' + inr(d.unrealisedPnl) + '</span></div></div>'
    + '<div class="sc"><div class="sc-label">' + (d.staleSession ? 'Trades (Last Session)' : 'Trades Today') + '</div><div class="sc-val">' + (d.tradeCount + d.positions.length + (d.priorTradesToday || 0)) + ' / ' + d.maxTrades + '</div><div class="sc-sub">' + d.wins + 'W \\u00b7 ' + d.losses + 'L \\u00b7 ' + d.positions.length + ' open</div></div>'
    + '<div class="sc"><div class="sc-label">Scan (' + esc(sc.universe || d.config.universe) + ')</div><div class="sc-val">' + sc.done + ' / ' + sc.total + '</div><div class="bar"><i style="width:' + pct + '%"></i></div><div class="sc-sub">' + esc(sc.status) + (sc.failed ? ' \\u00b7 ' + sc.failed + ' failed' : '') + (sc.error ? ' \\u00b7 ' + esc(sc.error) : '') + '</div></div>'
    + '<div class="sc"><div class="sc-label">Candidates</div><div class="sc-val">' + sc.candidates + '</div><div class="sc-sub">RSI &lt; ' + d.config.rsiLower + ' or &gt; ' + d.config.rsiUpper + ' yesterday</div></div>'
    + '<div class="sc"><div class="sc-label">Today\\u2019s Decision</div><div class="sc-val" style="font-size:0.9rem;" class="' + (d.dayDone ? 'amb' : '') + '">' + (d.dayDone ? 'Decided' : 'Open') + '</div><div class="sc-sub">' + esc(d.dayDone || ('window ' + d.config.window + ' \\u00b7 square-off ' + d.config.eod)) + '</div></div>'
    + '<div class="sc"><div class="sc-label">Price Updates</div><div class="sc-val">' + d.updates + '</div><div class="sc-sub">stream + REST for held stocks</div></div>'
    + '<div class="sc"><div class="sc-label">Session Start</div><div class="sc-val" style="font-size:0.85rem;">' + esc(d.sessionStart || '\\u2014') + '</div></div>'
    + '</div>';
  h += '<div class="card"><div class="note" style="margin-top:0;">Rules: yesterday\\u2019s daily RSI(' + d.config.rsiLen + ') on EMA(' + d.config.emaLen + ') below ' + d.config.rsiLower + ' + gap UP \\u2192 <b class="pos">BUY</b> \\u00b7 above ' + d.config.rsiUpper + ' + gap DOWN \\u2192 <b class="neg">SHORT</b>. Stop = yesterday\\u2019s close. Exit on a ' + d.config.exitTf + '-min close through EMA' + d.config.trailLen + ', or ' + d.config.eod + '. Biggest gaps first, max ' + d.maxTrades + ' a day. Common rules: ' + esc(d.config.common) + '.'
    + (d.reference ? '<br>Reference: <a href="' + esc(d.reference) + '" target="_blank" rel="noopener" style="color:#60a5fa;">' + esc(d.reference) + '</a>' : '') + '</div></div>';

  h += '<div class="section-title">Open Positions</div>';
  if (!d.positions.length) h += '<div class="card mut" style="font-size:0.78rem;text-align:center;">\\ud83d\\udced FLAT \\u2014 ' + esc(d.dayDone || (d.running ? 'waiting for the 09:15 open' : 'not running')) + '</div>';
  else {
    h += '<div class="tbl-wrap"><table><thead><tr><th>Stock</th><th>Side</th><th>Qty</th><th>Entry</th><th>LTP</th><th>SL (prev close)</th><th>EMA' + d.config.trailLen + '</th><th>P&amp;L</th><th></th></tr></thead><tbody>';
    d.positions.forEach(function(p){
      h += '<tr><td><b>' + esc(p.stock) + '</b></td><td class="' + (p.direction === 'LONG' ? 'pos' : 'neg') + '">' + esc(p.direction) + '</td><td>' + p.qty + '</td><td>' + inr(p.entryPrice) + '</td><td>' + inr(p.ltp) + '</td><td class="amb">' + inr(p.stopLoss) + '</td><td>' + (p.trailEma != null ? inr(p.trailEma) : '\\u2014') + '</td><td class="' + cls(p.pnl) + '"><b>' + inr(p.pnl) + '</b></td>'
        + '<td><button class="btn" onclick="grExit(this, \\'' + esc(p.stock) + '\\')">Exit</button></td></tr>';
    });
    h += '</tbody></table></div>';
  }

  h += '<div class="section-title">Scanner — Today\\u2019s Candidates</div>';
  if (!d.decisions.length) h += '<div class="card mut" style="font-size:0.76rem;">' + (sc.status === 'done' ? 'No stock had an extreme RSI yesterday \\u2014 no trades today.' : sc.status === 'running' ? 'Scanning\\u2026 ' + pct + '%' : 'Start the session to scan.') + '</div>';
  else {
    h += '<div class="tbl-wrap"><table><thead><tr><th>Stock</th><th>RSI</th><th>Zone</th><th>Prev close</th><th>Open</th><th>Gap</th><th>Status</th><th>Note</th></tr></thead><tbody>';
    d.decisions.forEach(function(x){
      var s = STATUS[x.status] || [x.status, 'mut'];
      h += '<tr><td><b>' + esc(x.stock) + '</b></td><td>' + esc(x.prevRsi) + '</td><td class="' + (x.zone === 'OVERSOLD' ? 'pos' : 'neg') + '">' + esc(x.zone) + '</td><td>' + inr(x.prevClose) + '</td><td>' + (x.open != null ? inr(x.open) : '\\u2014') + '</td>'
        + '<td class="' + cls(x.gapPct) + '">' + (x.gapPct != null ? (x.gapPct > 0 ? '+' : '') + x.gapPct + '%' : '\\u2014') + '</td><td class="' + s[1] + '">' + esc(s[0]) + '</td><td class="wrap">' + esc(x.note || '') + '</td></tr>';
    });
    h += '</tbody></table></div>';
  }

  h += '<div class="section-title">Session Trades</div>';
  if (!d.trades.length) h += '<div class="card mut" style="font-size:0.76rem;">No trades yet.</div>';
  else {
    h += '<div class="tbl-wrap"><table><thead><tr><th>Stock</th><th>Side</th><th>Qty</th><th>Entry</th><th>Exit</th><th>P&amp;L</th><th>Charges</th><th>Reason</th></tr></thead><tbody>';
    d.trades.slice().reverse().forEach(function(t){
      h += '<tr><td><b>' + esc(t.stock) + '</b><div class="mut" style="font-size:0.6rem;">' + esc(t.entryTime) + '</div></td><td class="' + (t.side === 'CE' ? 'pos' : 'neg') + '">' + esc(t.direction) + '</td><td>' + t.qty + '</td><td>' + inr(t.entryPrice) + '</td><td>' + inr(t.exitPrice) + '</td><td class="' + cls(t.pnl) + '"><b>' + inr(t.pnl) + '</b></td><td class="mut">' + inr(t.charges) + '</td><td class="wrap">' + esc(t.reason) + '</td></tr>';
    });
    h += '</tbody></table></div>';
  }
  document.getElementById('gr-root').innerHTML = h;
  document.getElementById('gr-log').textContent = (d.logs || []).join('\\n') || 'No log yet.';
}
var GR = JSON.parse(document.getElementById('gr-data').textContent);
render(GR);
var _wasRunning = GR.running;
setInterval(async function(){
  if (document.hidden) return;
  try {
    var r = await fetch('/gap_runaway_stk-paper/status/data', { cache: 'no-store' });
    if (!r.ok) return;
    var d = await r.json();
    if (d.running !== _wasRunning) { location.reload(); return; }
    render(d);
  } catch (_) {}
}, 2000);
async function grCall(url, btn, label){
  if (btn) { btn.disabled = true; btn.textContent = '\\u23f3 ' + label + '\\u2026'; }
  try {
    var r = await secretFetch(url);
    if (!r) { if (btn) btn.disabled = false; return; }
    var d = await r.json().catch(function(){ return { success:false, error:'Server error' }; });
    if (!d.success) { await showAlert({ icon:'\\u26a0\\ufe0f', title: label + ' failed', message: d.error || 'unknown', btnClass:'modal-btn-danger' }); if (btn) { btn.disabled = false; btn.textContent = label; } return; }
    location.reload();
  } catch (e) { await showAlert({ icon:'\\u26a0\\ufe0f', title: label + ' error', message: e.message, btnClass:'modal-btn-danger' }); if (btn) btn.disabled = false; }
}
// Copies the WHOLE log (GET /logs), not just the 150 lines on screen. The
// ClipboardItem-with-a-promise form keeps Safari's user-gesture rule happy.
async function grCopyLog(btn){
  var orig = btn.textContent;
  function done(){ btn.classList.add('copied'); btn.textContent = '\u2705 Copied!'; setTimeout(function(){ btn.classList.remove('copied'); btn.textContent = orig; }, 2000); }
  function getText(){ return fetch('/gap_runaway_stk-paper/logs', { cache: 'no-store' }).then(function(r){ return r.text(); }); }
  try {
    if (window.ClipboardItem && navigator.clipboard && navigator.clipboard.write) {
      await navigator.clipboard.write([new ClipboardItem({ 'text/plain': getText().then(function(t){ return new Blob([t], { type: 'text/plain' }); }) })]);
      return done();
    }
  } catch (_) {}
  var txt = await getText().catch(function(){ return document.getElementById('gr-log').textContent; });
  try { await navigator.clipboard.writeText(txt); return done(); } catch (_) {}
  var ta = document.createElement('textarea'); ta.value = txt; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta); done();
}
function grStart(btn){ grCall('/gap_runaway_stk-paper/start', btn, 'Start'); }
function grStop(btn){ grCall('/gap_runaway_stk-paper/stop', btn, 'Stop'); }
function grExit(btn, stock){ grCall('/gap_runaway_stk-paper/exit' + (stock ? '?stock=' + encodeURIComponent(stock) : ''), btn, 'Exit'); }
async function grReset(btn){
  var ok = await showConfirm({ icon:'\\u21ba', title:'Reset paper history?', message:'Wipes every saved session and resets capital.', confirmText:'Reset', btnClass:'modal-btn-danger' });
  if (ok) grCall('/gap_runaway_stk-paper/reset', btn, 'Reset');
}
</script>
</body>
</html>`);
});

// ── History / downloads / reset / sessions (shared history UI) ───────────────
router.get("/history", (req, res) => {
  const data = loadPaperData();
  res.setHeader("Content-Type", "text/html");
  res.send(renderHistoryPage({
    routePrefix: "/gap_runaway_stk-paper",
    sidebarKey: "gapRunawayStkHistory",
    pageTitle: `📉 ${LABEL} Paper Trade History`,
    pageDocTitle: `${LABEL} Paper — History`,
    modalLabel: `${LABEL} Paper`,
    liveActive: false,
    sessions: data.sessions || [],
    capital: data.capital,
    totalPnl: data.totalPnl,
    startCap: getCapitalFromEnv(),
    emptyLabel: `Start ${LABEL} paper trading to record your first session.`,
  }));
});

router.get("/download/trades.jsonl", (req, res) => {
  const logPath = tradeLogger.filePathFor(MODE_KEY);
  const today = _todayStr();
  if (!fs.existsSync(logPath)) return res.status(404).send("No trades logged yet.");
  if (req.query && req.query.format === "ai") {
    const text = fs.readFileSync(logPath, "utf-8");
    const md = aiExport.jsonlToMarkdown(text, { title: `${LABEL} paper trades (full log)`, source: "gap_runaway_stk-paper" });
    res.setHeader("Content-Type", "text/markdown; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="gap_runaway_stk_paper_trades_AI_${today}.md"`);
    return res.send(md);
  }
  return res.download(logPath, `gap_runaway_stk_paper_trades_log_${today}.txt`);
});

const _DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
router.get("/download/daily-files", (req, res) => {
  const skips  = skipLogger.listDates(MODE_KEY);
  const trades = tradeLogger.listDailyDates(MODE_KEY);
  return res.json(dailyFilesPaginate(skips, trades, req.query));
});
router.get("/download/skips/:date", (req, res) => {
  const date = String(req.params.date || "");
  if (!_DATE_RE.test(date)) return res.status(400).send("bad date");
  const p = skipLogger.filePathFor(MODE_KEY, date);
  if (!fs.existsSync(p)) return res.status(404).send("no skips for that day");
  res.download(p, `gap_runaway_stk_paper_skips_${date}.txt`);
});
router.get("/download/trades/:date", (req, res) => {
  const date = String(req.params.date || "");
  if (!_DATE_RE.test(date)) return res.status(400).send("bad date");
  const p = tradeLogger.dailyFilePathFor(MODE_KEY, date);
  if (!fs.existsSync(p)) return res.status(404).send("no trades for that day");
  res.download(p, `gap_runaway_stk_paper_trades_${date}.txt`);
});
router.get("/view/skips/:date", (req, res) => {
  const date = String(req.params.date || "");
  if (!_DATE_RE.test(date)) return res.status(400).send("bad date");
  const p = skipLogger.filePathFor(MODE_KEY, date);
  if (!fs.existsSync(p)) return res.status(404).send("no skips for that day");
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  return res.send(fs.readFileSync(p, "utf-8"));
});
router.get("/view/trades/:date", (req, res) => {
  const date = String(req.params.date || "");
  if (!_DATE_RE.test(date)) return res.status(400).send("bad date");
  const p = tradeLogger.dailyFilePathFor(MODE_KEY, date);
  if (!fs.existsSync(p)) return res.status(404).send("no trades for that day");
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  return res.send(fs.readFileSync(p, "utf-8"));
});

router.get("/reset", (req, res) => {
  if (st.running) return res.status(400).json({ success: false, error: "Stop paper trading first before resetting." });
  const cap = getCapitalFromEnv();
  savePaperData({ capital: cap, totalPnl: 0, sessions: [] });
  require("../utils/paperReset").clearTodayFiles(MODE_KEY);
  capitalPool.sessionSaved(MODE_KEY);
  try { if (fs.existsSync(POS_FILE)) fs.unlinkSync(POS_FILE); } catch (_) {}
  st.sessionTrades = []; st.sessionPnl = 0; st.wins = 0; st.losses = 0; st._staleSession = false;
  return res.json({ success: true, message: `Paper trade history cleared. Capital reset to ₹${cap.toLocaleString("en-IN")}` });
});

router.delete("/session/:index", (req, res) => {
  if (st.running) return res.status(400).json({ success: false, error: "Stop paper trading first before deleting a session." });
  const data = loadPaperData();
  const idx = parseInt(req.params.index, 10);
  if (!Number.isFinite(idx) || idx < 0 || idx >= data.sessions.length) return res.status(400).json({ success: false, error: "Invalid session index." });
  data.sessions.splice(idx, 1);
  data.totalPnl = _r2(data.sessions.reduce((s, x) => s + (Number(x.sessionPnl) || 0), 0));
  data.capital = _r2(getCapitalFromEnv() + data.totalPnl);
  savePaperData(data);
  return res.json({ success: true, message: "Session deleted.", capital: data.capital, totalPnl: data.totalPnl });
});

router.post("/restore-session/:date", (req, res) => {
  if (st.running) return res.status(400).json({ success: false, error: "Stop paper trading before restoring." });
  const date = String(req.params.date || "").trim();
  if (!_DATE_RE.test(date)) return res.status(400).json({ success: false, error: "Invalid date — expected YYYY-MM-DD." });
  const all = tradeLogger.readDailyTrades(MODE_KEY, date).filter(t => t && !t.type && t.stock);
  if (!all.length) return res.status(404).json({ success: false, error: "No trades found in daily JSONL for that date." });
  const data = loadPaperData();
  const keyOf = (t) => String(t.entryTime || "") + "|" + String(t.stock || "");
  const seen = new Set();
  for (const s of (data.sessions || [])) for (const t of (s.trades || [])) seen.add(keyOf(t));
  const missing = all.filter(t => !seen.has(keyOf(t)));
  if (!missing.length) return res.json({ success: true, restored: 0, message: "Nothing to restore — all trades already in sessions." });
  const pnl = _r2(missing.reduce((s, t) => s + (Number(t.pnl) || 0), 0));
  const wins = missing.filter(t => Number(t.pnl) > 0).length;
  data.sessions.push({
    date, strategy: PREFIX, instrument: "NSE_EQUITY_MIS",
    startTime: missing[0].entryTime || date, endTime: missing[missing.length - 1].exitTime || date,
    trades: missing, totalTrades: missing.length, wins, losses: missing.length - wins,
    winRate: `${((wins / missing.length) * 100).toFixed(1)}%`, sessionPnl: pnl, restoredFromJsonl: true,
  });
  data.sessions.sort((a, b) => istDayFromAny(a.date).localeCompare(istDayFromAny(b.date)));
  data.totalPnl = _r2(data.sessions.reduce((s, x) => s + (Number(x.sessionPnl) || 0), 0));
  data.capital = _r2(getCapitalFromEnv() + data.totalPnl);
  savePaperData(data);
  return res.json({ success: true, restored: missing.length, sessionPnl: pnl, message: `Restored ${missing.length} trade(s).` });
});

router.get("/debug", (req, res) => {
  res.json({
    running: st.running, scan: st.scan.status, scanned: `${st.scan.done}/${st.scan.total}`,
    candidates: st.scan.candidates.length, decisions: st.decisions.size, positions: [...st.positions.keys()],
    dayDone: st._dayDone ? st._dayDoneReason : null, opensDone: st._opensDone, busy: _busy,
    priorTradesToday: st._priorTradesToday, config: _cfg(),
  });
});

/** gracefulShutdown hook (app.js) — square off + save. Idempotent. */
function stopSession(reason = "Shutdown square-off") { try { _stopSession(reason); } catch (_) {} }
router.stopSession = stopSession;
// Exported for the regression suite.
router._misCharges = misCharges;
router._state = () => st;

module.exports = router;

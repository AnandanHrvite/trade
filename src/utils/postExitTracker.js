/**
 * postExitTracker.js — after a paper trade exits, keep watching the price the
 * trade was quoted in until THAT market's close, so we can later see what the
 * exit left on the table (or saved us from) and how long the move kept going.
 *
 * For every closed trade it records, in spot points from the exit price:
 *   best   — furthest move in the trade's direction after exit (+ time, and
 *            minutes after the exit it came — "how long the swing ran")
 *   worst  — furthest move against it after exit (+ time, minutes after exit)
 *   spot at +5 / +15 / +30 / +60 min after exit, and the last spot before close
 *
 * Which price: the trade's own spot symbol when it carries one, else the
 * market's index/stock from SPOT_BY_MARKET below. Close: 15:30 IST for NSE/BSE
 * markets, 23:30 IST for MCX. Both tables are this file's own small copy of
 * the market list; src/config/markets.js will own them once it lands.
 *
 * At the close each trade gets ONE summary line in the server log (tagged with
 * the strategy, so the Server Logs strategy filter shows it) and one JSON line
 * in ~/trading-data/post_exit/YYYY-MM-DD.jsonl for later analysis.
 *
 * Restart-safe: open watches are saved to ~/trading-data/post_exit/_pending.json
 * (tmp file → rename, so a crash mid-write never leaves a torn file) when a
 * watch starts, every CHECK_MS while ticks are arriving, when one finishes, and
 * synchronously on process exit. resume() — called once at boot — reloads them:
 * a watch whose market is still open carries on; one whose close passed while
 * the app was down is finalised from what it had collected. Each resumed
 * record says how many restarts it survived and for how many minutes it saw no
 * ticks because of them.
 *
 * Pure observer: it reads ticks through socketManager's fan-out (never opens a
 * socket, never subscribes a symbol the feed is not already carrying) and
 * nothing reads its output back into any decision.
 */

"use strict";

const fs   = require("fs");
const path = require("path");
const os   = require("os");

const OUT_DIR       = path.join(os.homedir(), "trading-data", "post_exit");
const PENDING_FILE  = path.join(OUT_DIR, "_pending.json");
const PENDING_VER   = 1;
const NSE_CLOSE_MIN = 15 * 60 + 30;          // 15:30 IST — NSE / BSE cash + F&O
const MCX_CLOSE_MIN = 23 * 60 + 30;          // 23:30 IST — MCX commodities
const MARKS_MIN     = [5, 15, 30, 60];
const CHECK_MS      = 30 * 1000;
const CALLBACK_PREF = "post-exit:";

// Market → the spot it is quoted in. MCX markets are absent on purpose: their
// price is a futures contract that rolls monthly, so it must come from the
// trade's own `spotSymbol`.
const SPOT_BY_MARKET = {
  NIFTY:     "NSE:NIFTY50-INDEX",
  BANKNIFTY: "NSE:NIFTYBANK-INDEX",
  SENSEX:    "BSE:SENSEX-INDEX",
  SAIL:      "NSE:SAIL-EQ",
};
const MCX_MARKETS = new Set(["MCX", "COMMODITY", "CRUDE", "CRUDEOIL", "CRUDEOILM", "GOLD", "GOLDM", "SILVER", "SILVERM", "NATURALGAS", "COPPER"]);

const trackers = [];        // open watches
const callbacks = new Set(); // spot symbols we registered a callback for
let timer = null;
let dirty = false;           // ticks moved a watch since the last save
let exitHookOn = false;

function istParts(ms) {
  const d = new Date(ms + 19800000);
  const y = d.getUTCFullYear(), mo = d.getUTCMonth() + 1, da = d.getUTCDate();
  const h = d.getUTCHours(), mi = d.getUTCMinutes(), s = d.getUTCSeconds();
  const p = (n) => (n < 10 ? "0" : "") + n;
  return { date: `${y}-${p(mo)}-${p(da)}`, min: h * 60 + mi, hhmm: `${p(h)}:${p(mi)}`, hms: `${p(h)}:${p(mi)}:${p(s)}` };
}

const hhmmOf = (min) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

/** Minutes after midnight IST at which `market` closes. */
function closeMinFor(market) {
  const m = String(market || "").toUpperCase();
  if (MCX_MARKETS.has(m) || m.startsWith("MCX")) return MCX_CLOSE_MIN;
  return NSE_CLOSE_MIN;
}

/**
 * The symbol whose price the trade's spotAtExit is quoted in. null = cannot be
 * tracked. Order: the trade's own spot symbol; a cash-equity trade's own symbol
 * (its price IS the spot); the market's fixed spot; the legacy mode rule.
 */
function spotSymbolFor(mode, trade, market) {
  const t = trade || {};
  for (const own of [t.spotSymbol, t.underlyingSymbol]) {
    if (typeof own === "string" && own.includes(":")) return own;
  }
  const instr = String(t.instrument || "").toUpperCase();
  if ((t.isSpot === true || instr.startsWith("NSE_EQUITY")) && typeof t.symbol === "string" && t.symbol.includes(":")) {
    return t.symbol;
  }
  const mk = String(market || "").toUpperCase();
  if (SPOT_BY_MARKET[mk]) return SPOT_BY_MARKET[mk];
  if (mk && mk !== "NIFTY") return null;           // a market with no fixed spot
  const m = String(mode || "");
  if (m === "gap_runaway_stk") return null;          // many stocks, symbol varies
  if (m.startsWith("sail_")) return SPOT_BY_MARKET.SAIL;
  return SPOT_BY_MARKET.NIFTY;
}

function dirOf(side) {
  const s = String(side || "").toUpperCase();
  if (s === "CE" || s === "BUY" || s === "LONG") return 1;
  if (s === "PE" || s === "SELL" || s === "SHORT") return -1;
  return 0;
}

function sockMgr() {
  try { return require("./socketManager"); } catch (_) { return null; }
}

function ensureCallback(sym) {
  const sm = sockMgr();
  if (!sm || typeof sm.addCallback !== "function") return;
  // Observer only: never make the feed subscribe something new. Ride along
  // only when the symbol is already streaming for some strategy.
  const subs = typeof sm.spotSymbols === "function" ? sm.spotSymbols() : [];
  if (!subs.includes(sym)) return;
  // Idempotent: re-asserted every check because socketManager.stop() clears
  // all callbacks, and the feed may come back while we still have trades open.
  sm.addCallback(CALLBACK_PREF + sym, (t) => onTick(sym, t), null, sym);
  callbacks.add(sym);
}

function onTick(sym, t) {
  const px = t && Number(t.ltp);
  if (!Number.isFinite(px) || px <= 0) return;
  const now = Date.now();
  const ist = istParts(now);
  for (const k of trackers) {
    if (k.sym !== sym) continue;
    // A tick after this market's close (or on a later day) is not "before close".
    if (ist.date !== k.date || ist.min >= k.closeMin) continue;
    k.ticks++;
    if (k.hi == null || px > k.hi.px) k.hi = { px, ms: now };
    if (k.lo == null || px < k.lo.px) k.lo = { px, ms: now };
    k.last = { px, ms: now };
    for (const m of MARKS_MIN) {
      if (k.marks[m] == null && now - k.exitMs >= m * 60000) k.marks[m] = { px, ms: now };
    }
    dirty = true;
  }
}

/**
 * Called from tradeLogger.appendTradeLog for every closed trade. `tags` carries
 * the market + strategy id tradeLogger stamped on the persisted line.
 */
function track(mode, trade, tags) {
  if (!trade || typeof trade !== "object" || trade.type) return;
  const exitSpot = Number(trade.spotAtExit != null ? trade.spotAtExit : trade.exitSpot);
  const dir = dirOf(trade.side);
  const market = (tags && tags.market) || "NIFTY";
  const sym = spotSymbolFor(mode, trade, market);
  if (!Number.isFinite(exitSpot) || exitSpot <= 0 || !dir || !sym) return;
  const now = Date.now();
  const ist = istParts(now);
  const closeMin = closeMinFor(market);
  if (ist.min >= closeMin) return;                   // nothing left to watch
  const entrySpot = Number(trade.spotAtEntry != null ? trade.spotAtEntry : trade.entrySpot);
  trackers.push({
    mode: String(mode), market, strategy: (tags && tags.strategy) || String(mode).toUpperCase(),
    sym, dir, closeMin,
    side: trade.side, symbol: trade.symbol || null,
    exitSpot, exitMs: now, exitTime: trade.exitTime || ist.hms,
    entryTime: trade.entryTime || null, spotAtEntry: Number.isFinite(entrySpot) && entrySpot > 0 ? entrySpot : null,
    entryReason: trade.entryReason != null ? trade.entryReason : null,
    exitReason: trade.exitReason != null ? trade.exitReason : null,
    pnl: Number.isFinite(Number(trade.pnl)) ? Number(trade.pnl) : null,
    date: ist.date, hi: null, lo: null, last: null, marks: {}, ticks: 0,
    restarts: 0, downtimeMs: 0,
  });
  ensureCallback(sym);
  ensureTimer();
  persist();
}

function ensureTimer() {
  if (!exitHookOn) {
    exitHookOn = true;
    // Last save on the way out: covers the ticks since the last 30 s save and
    // any exits gracefulShutdown's square-off just logged.
    process.once("exit", () => { try { persistSync(); } catch (_) {} });
  }
  if (timer) return;
  timer = setInterval(check, CHECK_MS);
  if (timer.unref) timer.unref();
}

function check() {
  const now = istParts(Date.now());
  for (const sym of new Set(trackers.map(k => k.sym))) {
    try { ensureCallback(sym); } catch (_) {}
  }
  // Finalise at each watch's own market close, and any left over from an earlier day.
  const due = trackers.filter(k => now.min >= k.closeMin || k.date !== now.date);
  if (due.length) finalise(due);
  else if (dirty) persist();
}

const r1 = (n) => Math.round(n * 10) / 10;
const sgn = (n) => (n > 0 ? "+" : n < 0 ? "−" : "") + Math.abs(r1(n)).toFixed(1);
const minsAfter = (k, ms) => (ms != null && Number.isFinite(ms) ? r1((ms - k.exitMs) / 60000) : null);

function summarise(k) {
  const fav = (px) => r1((px - k.exitSpot) * k.dir);
  const best  = k.dir > 0 ? k.hi : k.lo;
  const worst = k.dir > 0 ? k.lo : k.hi;
  const point = (p) => (p ? { spot: p.px, pts: fav(p.px), time: p.ms != null ? istParts(p.ms).hhmm : null, minutesAfterExit: minsAfter(k, p.ms) } : null);
  const marks = {};
  for (const m of MARKS_MIN) {
    const v = k.marks[m];
    const p = v == null ? null : (typeof v === "number" ? { px: v, ms: null } : v);
    marks[`plus${m}m`] = p ? { spot: p.px, pts: fav(p.px), time: p.ms != null ? istParts(p.ms).hhmm : null } : null;
  }
  const bestPt = point(best);
  return {
    type: "post_exit", date: k.date, mode: k.mode,
    market: k.market || "NIFTY", strategy: k.strategy || String(k.mode).toUpperCase(),
    underlying: k.sym, marketClose: hhmmOf(k.closeMin != null ? k.closeMin : NSE_CLOSE_MIN),
    side: k.side, symbol: k.symbol, entryTime: k.entryTime, spotAtEntry: k.spotAtEntry,
    entryReason: k.entryReason != null ? k.entryReason : null,
    exitTime: k.exitTime, spotAtExit: k.exitSpot, exitReason: k.exitReason, pnl: k.pnl,
    ticksAfterExit: k.ticks,
    bestAfterExit:  bestPt,
    worstAfterExit: point(worst),
    minutesToBest:  bestPt ? bestPt.minutesAfterExit : null,
    ...marks,
    lastBeforeClose: k.last ? { spot: k.last.px, pts: fav(k.last.px), time: istParts(k.last.ms).hhmm } : null,
    restarts: k.restarts || 0,
    downtimeMin: r1((k.downtimeMs || 0) / 60000),
  };
}

function lineFor(rec) {
  const tag = `[${rec.mode.toUpperCase()}-PAPER]`;
  const mkt = rec.market && rec.market !== "NIFTY" ? ` ${rec.market}` : "";
  const head = `🔭 ${tag} AFTER EXIT —${mkt} ${rec.side} exited ${rec.exitTime} at spot ${rec.spotAtExit}` +
    (rec.exitReason ? ` (${rec.exitReason})` : "") + (rec.pnl != null ? `, P&L ₹${rec.pnl}` : "");
  const gap = rec.restarts ? ` (${rec.restarts} restart${rec.restarts > 1 ? "s" : ""}, ~${rec.downtimeMin} min not watched)` : "";
  if (!rec.ticksAfterExit) return `${head}. No price ticks after exit (feed was off), so nothing to report${gap}.`;
  const b = rec.bestAfterExit, w = rec.worstAfterExit, l = rec.lastBeforeClose;
  const marks = MARKS_MIN.map(m => rec[`plus${m}m`] ? `+${m}m ${sgn(rec[`plus${m}m`].pts)}` : null).filter(Boolean).join(" · ");
  return `${head}. After exit, best move for this ${rec.side}: ${sgn(b.pts)} pts (spot ${b.spot} at ${b.time}, ${b.minutesAfterExit} min after exit); ` +
    `worst: ${sgn(w.pts)} pts (spot ${w.spot} at ${w.time})` +
    (marks ? `. ${marks}` : "") +
    `. Last ${l.time}: spot ${l.spot} (${sgn(l.pts)} pts)${gap}.`;
}

function finalise(list) {
  let logAs = null;
  try { logAs = require("../services/logger").logAs; } catch (_) {}
  const byDate = new Map();
  for (const k of list) {
    const i = trackers.indexOf(k);
    if (i !== -1) trackers.splice(i, 1);
    const rec = summarise(k);
    const line = lineFor(rec);
    try { if (logAs) logAs(rec.mode, line); else console.log(line); } catch (_) {}
    if (!byDate.has(rec.date)) byDate.set(rec.date, []);
    byDate.get(rec.date).push(JSON.stringify(rec));
  }
  try { fs.mkdirSync(OUT_DIR, { recursive: true }); } catch (_) {}
  for (const [date, lines] of byDate) {
    // Sync: the result line must be on disk before the watch leaves _pending.json,
    // or a crash between the two loses it. Once per finished watch — not a hot path.
    try { fs.appendFileSync(path.join(OUT_DIR, `${date}.jsonl`), lines.join("\n") + "\n"); }
    catch (err) { console.warn(`[postExitTracker] write failed: ${err.message}`); }
  }
  persist();
  // Nothing left on a symbol → drop its callback.
  const sm = sockMgr();
  for (const sym of Array.from(callbacks)) {
    if (trackers.some(k => k.sym === sym)) continue;
    callbacks.delete(sym);
    try { if (sm && typeof sm.removeCallback === "function") sm.removeCallback(CALLBACK_PREF + sym); } catch (_) {}
  }
  if (!trackers.length && timer) { clearInterval(timer); timer = null; }
}

// ── Persistence ──────────────────────────────────────────────────────────────

function _pendingJson() {
  return JSON.stringify({ version: PENDING_VER, savedAt: Date.now(), watches: trackers });
}

function _writeAtomicSync(text, tmpTag) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const tmp = `${PENDING_FILE}.${process.pid}.${tmpTag}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, PENDING_FILE);
}

let _writing = false;
let _again = false;
/** Async atomic save of the open watches. Coalesced: one write in flight at a time. */
function persist() {
  dirty = false;
  if (_writing) { _again = true; return; }
  _writing = true;
  const text = _pendingJson();
  const tmp = `${PENDING_FILE}.${process.pid}.async.tmp`;
  fs.promises.mkdir(OUT_DIR, { recursive: true })
    .then(() => fs.promises.writeFile(tmp, text))
    .then(() => fs.promises.rename(tmp, PENDING_FILE))
    .catch(err => console.warn(`[postExitTracker] pending save failed: ${err.message}`))
    .then(() => {
      _writing = false;
      if (_again) { _again = false; persist(); }
    });
}

/** Synchronous save — process exit, and tests. */
function persistSync() {
  dirty = false;
  try { _writeAtomicSync(_pendingJson(), "sync"); }
  catch (err) { console.warn(`[postExitTracker] pending save failed: ${err.message}`); }
}

function _validWatch(w) {
  return w && typeof w === "object"
    && typeof w.mode === "string" && typeof w.sym === "string" && typeof w.date === "string"
    && (w.dir === 1 || w.dir === -1)
    && Number.isFinite(Number(w.exitSpot)) && Number.isFinite(Number(w.exitMs));
}

/**
 * Boot: reload the watches a restart interrupted. Idempotent — a watch already
 * open (same mode, symbol and exit time) is not added twice. Returns
 * { resumed, finalised } counts.
 */
function resume() {
  let saved;
  try { saved = JSON.parse(fs.readFileSync(PENDING_FILE, "utf-8")); }
  catch (err) {
    if (err.code !== "ENOENT") console.warn(`[postExitTracker] pending file unreadable, ignored: ${err.message}`);
    return { resumed: 0, finalised: 0 };
  }
  const list = saved && Array.isArray(saved.watches) ? saved.watches : [];
  const savedAt = Number(saved && saved.savedAt);
  const nowMs = Date.now();
  const now = istParts(nowMs);
  const due = [];
  let resumed = 0;
  for (const w of list) {
    if (!_validWatch(w)) continue;
    if (trackers.some(k => k.mode === w.mode && k.sym === w.sym && k.exitMs === Number(w.exitMs))) continue;
    const k = {
      ...w,
      exitSpot: Number(w.exitSpot), exitMs: Number(w.exitMs),
      closeMin: Number.isFinite(Number(w.closeMin)) ? Number(w.closeMin) : closeMinFor(w.market),
      marks: w.marks && typeof w.marks === "object" ? w.marks : {},
      ticks: Number(w.ticks) || 0,
      restarts: (Number(w.restarts) || 0) + 1,
      downtimeMs: Number(w.downtimeMs) || 0,
    };
    // Unwatched span: from the last save until now, capped at this watch's close.
    if (Number.isFinite(savedAt) && savedAt > 0) {
      const closeMs = Date.parse(`${k.date}T${hhmmOf(k.closeMin)}:00+05:30`);
      const until = Number.isFinite(closeMs) ? Math.min(nowMs, closeMs) : nowMs;
      k.downtimeMs += Math.max(0, until - Math.max(savedAt, k.exitMs));
    }
    trackers.push(k);
    if (now.date !== k.date || now.min >= k.closeMin) due.push(k);
    else { resumed++; ensureCallback(k.sym); }
  }
  if (due.length) finalise(due);
  if (trackers.length) ensureTimer();
  persist();
  if (resumed || due.length) {
    console.log(`🔭 [postExitTracker] restart: resumed ${resumed} post-exit watch(es), finalised ${due.length} whose market closed while the app was down`);
  }
  return { resumed, finalised: due.length };
}

module.exports = {
  track, resume, OUT_DIR, PENDING_FILE,
  _internals: { trackers, onTick, check, summarise, lineFor, finalise, spotSymbolFor, closeMinFor, persistSync, istParts },
};

/**
 * postExitTracker.js — after a paper trade exits, keep watching the
 * underlying's spot until 15:30 IST so we can later see what the exit left on
 * the table (or saved us from).
 *
 * For every closed trade it records, in spot points from the exit price:
 *   best   — furthest move in the trade's direction after exit (+ time)
 *   worst  — furthest move against it after exit (+ time)
 *   spot at +5 / +15 / +30 / +60 min after exit, and the last spot before 15:30
 *
 * At 15:30 IST each trade gets ONE summary line in the server log (tagged with
 * the strategy, so the Server Logs strategy filter shows it) and one JSON line
 * in ~/trading-data/post_exit/YYYY-MM-DD.jsonl for later analysis.
 *
 * Pure observer: it reads ticks through socketManager's fan-out (never opens a
 * socket) and nothing reads its output back into any decision. In-memory only,
 * so a restart mid-day drops the trades being watched.
 */

const fs   = require("fs");
const path = require("path");
const os   = require("os");

const OUT_DIR       = path.join(os.homedir(), "trading-data", "post_exit");
const EOD_MIN       = 15 * 60 + 30;          // 15:30 IST
const MARKS_MIN     = [5, 15, 30, 60];
const CHECK_MS      = 30 * 1000;
const NIFTY         = "NSE:NIFTY50-INDEX";
const CALLBACK_PREF = "post-exit:";

const trackers = [];        // open trackers (today)
const callbacks = new Set(); // spot symbols we registered a callback for
let timer = null;

function istParts(ms) {
  const d = new Date(ms + 19800000);
  const y = d.getUTCFullYear(), mo = d.getUTCMonth() + 1, da = d.getUTCDate();
  const h = d.getUTCHours(), mi = d.getUTCMinutes(), s = d.getUTCSeconds();
  const p = (n) => (n < 10 ? "0" : "") + n;
  return { date: `${y}-${p(mo)}-${p(da)}`, min: h * 60 + mi, hhmm: `${p(h)}:${p(mi)}`, hms: `${p(h)}:${p(mi)}:${p(s)}` };
}

// Which index/stock the trade's spotAtExit is quoted in. null = not tracked.
function spotSymbolFor(mode) {
  const m = String(mode || "");
  return NIFTY;
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
  // only when the index is already streaming for some strategy.
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
  for (const k of trackers) {
    if (k.sym !== sym) continue;
    k.ticks++;
    if (k.hi == null || px > k.hi.px) k.hi = { px, ms: now };
    if (k.lo == null || px < k.lo.px) k.lo = { px, ms: now };
    k.last = { px, ms: now };
    for (const m of MARKS_MIN) {
      if (k.marks[m] == null && now - k.exitMs >= m * 60000) k.marks[m] = px;
    }
  }
}

/** Called from tradeLogger.appendTradeLog for every closed trade. */
function track(mode, trade) {
  if (!trade || typeof trade !== "object" || trade.type) return;
  const exitSpot = Number(trade.spotAtExit);
  const dir = dirOf(trade.side);
  const sym = spotSymbolFor(mode);
  if (!Number.isFinite(exitSpot) || exitSpot <= 0 || !dir || !sym) return;
  const now = Date.now();
  if (istParts(now).min >= EOD_MIN) return;          // nothing left to watch
  trackers.push({
    mode: String(mode), sym, dir,
    side: trade.side, symbol: trade.symbol || null,
    exitSpot, exitMs: now, exitTime: trade.exitTime || istParts(now).hms,
    entryTime: trade.entryTime || null, spotAtEntry: Number(trade.spotAtEntry) || null,
    exitReason: trade.exitReason || null, pnl: Number.isFinite(Number(trade.pnl)) ? Number(trade.pnl) : null,
    date: istParts(now).date, hi: null, lo: null, last: null, marks: {}, ticks: 0,
  });
  ensureCallback(sym);
  ensureTimer();
}

function ensureTimer() {
  if (timer) return;
  timer = setInterval(check, CHECK_MS);
  if (timer.unref) timer.unref();
}

function check() {
  const now = istParts(Date.now());
  for (const sym of new Set(trackers.map(k => k.sym))) {
    try { ensureCallback(sym); } catch (_) {}
  }
  // Finalise at 15:30, and any tracker left over from an earlier day.
  const due = trackers.filter(k => now.min >= EOD_MIN || k.date !== now.date);
  if (due.length) finalise(due);
}

const r1 = (n) => Math.round(n * 10) / 10;
const sgn = (n) => (n > 0 ? "+" : n < 0 ? "−" : "") + Math.abs(r1(n)).toFixed(1);

function summarise(k) {
  const fav = (px) => r1((px - k.exitSpot) * k.dir);
  const best  = k.dir > 0 ? k.hi : k.lo;
  const worst = k.dir > 0 ? k.lo : k.hi;
  const marks = {};
  for (const m of MARKS_MIN) marks[`plus${m}m`] = k.marks[m] != null ? { spot: k.marks[m], pts: fav(k.marks[m]) } : null;
  return {
    type: "post_exit", date: k.date, mode: k.mode, underlying: k.sym,
    side: k.side, symbol: k.symbol, entryTime: k.entryTime, spotAtEntry: k.spotAtEntry,
    exitTime: k.exitTime, spotAtExit: k.exitSpot, exitReason: k.exitReason, pnl: k.pnl,
    ticksAfterExit: k.ticks,
    bestAfterExit:  best  ? { spot: best.px,  pts: fav(best.px),  time: istParts(best.ms).hhmm }  : null,
    worstAfterExit: worst ? { spot: worst.px, pts: fav(worst.px), time: istParts(worst.ms).hhmm } : null,
    ...marks,
    lastBeforeClose: k.last ? { spot: k.last.px, pts: fav(k.last.px), time: istParts(k.last.ms).hhmm } : null,
  };
}

function lineFor(rec) {
  const tag = `[${rec.mode.toUpperCase()}-PAPER]`;
  const head = `🔭 ${tag} AFTER EXIT — ${rec.side} exited ${rec.exitTime} at spot ${rec.spotAtExit}` +
    (rec.exitReason ? ` (${rec.exitReason})` : "") + (rec.pnl != null ? `, P&L ₹${rec.pnl}` : "");
  if (!rec.ticksAfterExit) return `${head}. No price ticks after exit (feed was off), so nothing to report.`;
  const b = rec.bestAfterExit, w = rec.worstAfterExit, l = rec.lastBeforeClose;
  const marks = MARKS_MIN.map(m => rec[`plus${m}m`] ? `+${m}m ${sgn(rec[`plus${m}m`].pts)}` : null).filter(Boolean).join(" · ");
  return `${head}. After exit, best move for this ${rec.side}: ${sgn(b.pts)} pts (spot ${b.spot} at ${b.time}); ` +
    `worst: ${sgn(w.pts)} pts (spot ${w.spot} at ${w.time})` +
    (marks ? `. ${marks}` : "") +
    `. Last ${l.time}: spot ${l.spot} (${sgn(l.pts)} pts).`;
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
    fs.promises.appendFile(path.join(OUT_DIR, `${date}.jsonl`), lines.join("\n") + "\n")
      .catch(err => console.warn(`[postExitTracker] write failed: ${err.message}`));
  }
  // Nothing left on a symbol → drop its callback.
  const sm = sockMgr();
  for (const sym of Array.from(callbacks)) {
    if (trackers.some(k => k.sym === sym)) continue;
    callbacks.delete(sym);
    try { if (sm && typeof sm.removeCallback === "function") sm.removeCallback(CALLBACK_PREF + sym); } catch (_) {}
  }
  if (!trackers.length && timer) { clearInterval(timer); timer = null; }
}

module.exports = { track, OUT_DIR, _internals: { trackers, onTick, summarise, lineFor, finalise, spotSymbolFor } };

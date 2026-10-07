/**
 * portfolioRisk.js — cross-strategy (portfolio-level) daily loss cap
 * ─────────────────────────────────────────────────────────────────────────────
 * Each strategy already caps its OWN daily loss, but nothing summed them, so all
 * strategies hitting their individual caps the same day could lose far more in
 * aggregate. This adds one portfolio-wide breaker.
 *
 * Design:
 *   • Source of truth = the per-day JSONL audit logs (tradeLogger.readDailyTrades),
 *     the same canonical files the per-strategy restart-recovery already trusts.
 *   • Sums TODAY's (IST) realized P&L across all paper strategy modes, plus the
 *     native live engines' {mode}_live_trades.json sessions for today. Paper is
 *     the canonical decision layer and harness-live mirrors it, so this is the
 *     right proxy for "how much has the book lost today".
 *   • The gate ONLY ever BLOCKS new entries — it can never place or alter an
 *     order — so it is strictly fail-safe.
 *   • Disabled by default: PORTFOLIO_MAX_DAILY_LOSS unset or <= 0 → never blocks.
 *     Set it (e.g. 12000) to arm the breaker.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const fs = require("fs");
const path = require("path");
const tradeLogger = require("./tradeLogger");
const { istDayFromAny } = require("./tradeUtils");

const DATA_DIR = path.join(require("os").homedir(), "trading-data");

// Paper modes = the canonical decision layer. Summing these gives the book's
// realized P&L for the day regardless of which surface (paper/harness-live) ran.
const PAPER_MODES = ["ema_rsi_st", "bb_rsi", "pa", "orb", "ema9vwap", "trend_pb", "trend_day_scalp", "rsi_pivot_st", "bn_pivot_rsi_st", "ema_rsi_st_v2", "bn_ema_rsi_st_v2", "simple930", "ha_scalp", "prev_orb_scalp", "early_bird"];

// Pull a realized P&L number out of a logged record. Trade exits carry `pnl`;
// harness EXIT events carry `paperPnl`. Snapshot / checkpoint lines carry
// neither and are skipped.
function _recordPnl(t) {
  if (!t) return null;
  if (Number.isFinite(Number(t.pnl)))      return Number(t.pnl);
  if (Number.isFinite(Number(t.paperPnl))) return Number(t.paperPnl);
  return null;
}

// Short-lived memo of the last aggregate. getTodayRealized reads 6 growing JSONL
// files synchronously; the intra-tick entry gates (EMA_RSI_ST / EMA9_VWAP) can
// call this on EVERY spot tick while flat, so at ~4-10 ticks/s an armed cap would
// otherwise do ~24-60 readFileSync+JSON.parse per second on the shared event
// loop. Realized P&L only changes on an exit, so a few seconds' staleness is
// harmless for a daily-loss breaker — cache it and cap disk reads at ~1/TTL.
let _memo = { date: null, ts: 0, val: null };
const _MEMO_TTL_MS = 3000;

// Native live engines (EMA_RSI_ST / BB_RSI / PA / ORB live routes) book their
// trades to ~/trading-data/{mode}_live_trades.json, not to the paper JSONL, so a
// paper-only sum ignored every real-money loss they made. Today's sessions there
// are added in. mtime-cached so the 3s memo refresh stays a stat() per file.
const _liveFileCache = new Map();   // file -> { sig, json }
function _readLiveFile(file) {
  const st = fs.statSync(file);
  const sig = `${st.mtimeMs}:${st.size}`;
  const c = _liveFileCache.get(file);
  if (c && c.sig === sig) return c.json;
  const json = JSON.parse(fs.readFileSync(file, "utf-8"));
  _liveFileCache.set(file, { sig, json });
  return json;
}

/** Today's realized P&L per native-live mode, keyed "<mode>_live". */
function _todayLiveSessions(dateStr) {
  const out = {};
  let files = [];
  try { files = fs.readdirSync(DATA_DIR).filter(f => /_live_trades\.json$/.test(f)); } catch (_) { return out; }
  for (const f of files) {
    const key = f.replace(/_trades\.json$/, "");          // e.g. "orb_live"
    let sum = 0, seen = false;
    try {
      const json = _readLiveFile(path.join(DATA_DIR, f));
      const sessions = Array.isArray(json) ? json : (json && Array.isArray(json.sessions) ? json.sessions : []);
      for (const s of sessions) {
        if (!s || istDayFromAny(s.date) !== dateStr) continue;
        seen = true;
        if (Array.isArray(s.trades) && s.trades.length) {
          for (const t of s.trades) { const p = _recordPnl(t); if (p !== null) sum += p; }
        } else if (Number.isFinite(Number(s.pnl))) {
          sum += Number(s.pnl);
        }
      }
    } catch (_) { /* unreadable live file → treat as 0 */ }
    if (seen) out[key] = parseFloat(sum.toFixed(2));
  }
  return out;
}

/**
 * Sum today's (IST) realized P&L across all paper strategy modes, plus today's
 * native-live sessions.
 * Pure read of on-disk logs — safe to call on any entry check. Memoized for a few
 * seconds so per-tick callers can't stall the event loop.
 * @returns {{ total: number, byMode: Object<string, number> }}
 */
function getTodayRealized() {
  const dateStr = tradeLogger.istDateString();
  const now = Date.now();
  // `now >= _memo.ts`: a replay rewinds the clock, so a memo stamped at the END
  // of one run would otherwise look "fresh" (negative age) for the whole of the
  // next run of that day and serve the full day's loss from the first tick.
  if (_memo.val && _memo.date === dateStr && now >= _memo.ts && (now - _memo.ts) < _MEMO_TTL_MS) {
    return _memo.val;
  }
  const byMode = {};
  let total = 0;
  // `_live: true` rows: a native live route (ORB live) also appends its exits to
  // the paper JSONL. They are real-time, so they ARE that mode's live P&L — but
  // they are kept out of the paper sum and stand in for the session file below,
  // so the same trade is never counted twice.
  const liveFromJsonl = {};
  for (const mode of PAPER_MODES) {
    let sum = 0, liveSum = 0, liveSeen = false;
    try {
      for (const t of tradeLogger.readDailyTrades(mode, dateStr)) {
        const p = _recordPnl(t);
        if (p === null) continue;
        if (t._live === true) { liveSum += p; liveSeen = true; }
        else sum += p;
      }
    } catch (_) { /* missing/unreadable log for this mode → treat as 0 */ }
    sum = parseFloat(sum.toFixed(2));
    byMode[mode] = sum;
    total += sum;
    if (liveSeen) liveFromJsonl[`${mode}_live`] = parseFloat(liveSum.toFixed(2));
  }
  const liveSessions = _todayLiveSessions(dateStr);
  const liveKeys = new Set([...Object.keys(liveSessions), ...Object.keys(liveFromJsonl)]);
  for (const key of liveKeys) {
    // Prefer the real-time JSONL rows when present (they include the session
    // still in progress); otherwise the saved sessions.
    const v = key in liveFromJsonl ? liveFromJsonl[key] : liveSessions[key];
    byMode[key] = v;
    total += v;
  }
  const val = { total: parseFloat(total.toFixed(2)), byMode };
  _memo = { date: dateStr, ts: now, val };
  return val;
}

function _cap() {
  const c = parseFloat(process.env.PORTFOLIO_MAX_DAILY_LOSS || "0");
  return Number.isFinite(c) ? c : 0;
}

/**
 * Portfolio-level gate. Returns { blocked, total, cap, disabled, reason }.
 * blocked=true means new entries across ALL strategies should be skipped for the
 * rest of the day. Never throws; on any error it fails OPEN (does not block) so
 * a logging glitch can't halt the whole book.
 */
function checkPortfolioCap() {
  try {
    const cap = _cap();
    if (!(cap > 0)) return { blocked: false, disabled: true, total: 0, cap: 0, reason: "portfolio cap disabled" };
    const { total } = getTodayRealized();
    const blocked = total <= -cap;
    return {
      blocked,
      disabled: false,
      total,
      cap,
      reason: blocked
        ? `portfolio loss ₹${total} <= -₹${cap} — all strategies paused for the day`
        : `portfolio P&L ₹${total} within -₹${cap}`,
    };
  } catch (err) {
    return { blocked: false, disabled: false, total: 0, cap: _cap(), reason: `portfolio check error (fail-open): ${err.message}` };
  }
}

module.exports = { getTodayRealized, checkPortfolioCap, PAPER_MODES };

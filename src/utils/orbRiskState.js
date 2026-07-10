/**
 * ORB RISK STATE — portfolio-level breakers for the ORB strategy
 * ─────────────────────────────────────────────────────────────────────────────
 * ORB is a low-win-rate, right-tail strategy: long losing streaks are normal.
 * These breakers keep a hostile regime from bleeding the account:
 *
 *   • Consecutive-losing-days skip — after ORB_LOSS_STREAK_SKIP losing days in a
 *     row, sit out today (the regime is hostile; wait for it to change).
 *   • Weekly loss stop — if the running realised P&L for the current ISO-week
 *     (Mon→today, including today) reaches −ORB_MAX_WEEKLY_LOSS, stop for the week.
 *
 * Persisted OUTSIDE the repo at ~/trading-data/orb_risk_state.json so `git pull`
 * / PM2 reloads never wipe it. Paper ("orb-paper") and live ("orb-live") track
 * SEPARATELY (different P&L streams). Block-only — position SIZING is unchanged
 * (deliberately: sizing changes are validated separately). Gated by
 * ORB_RISK_THROTTLE_ENABLED (default true).
 *
 * The scoring is a pure function (`evaluate`) so it can be unit-tested offline.
 */

const fs   = require("fs");
const path = require("path");

const DATA_DIR = path.join(require("os").homedir(), "trading-data");
const FILE     = path.join(DATA_DIR, "orb_risk_state.json");
const MAX_KEEP = 120;   // prune to the most recent N (mode,date) entries

function _load() {
  try { const d = JSON.parse(fs.readFileSync(FILE, "utf-8")); return (d && d.days) ? d : { days: {} }; }
  catch (_) { return { days: {} }; }
}
function _save(d) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(d, null, 2));
    fs.renameSync(tmp, FILE);
  } catch (e) { /* risk state is best-effort — never break a session on a write fail */ }
}

// Monday (ISO yyyy-mm-dd) of the ISO-week containing `iso`. Pure UTC arithmetic
// so the result never shifts with the server's local timezone (TZ=Asia/Calcutta).
function _mondayOf(iso) {
  const [y, m, dd] = iso.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1, dd));
  const day = d.getUTCDay();                  // 0 Sun … 6 Sat
  d.setUTCDate(d.getUTCDate() - (day === 0 ? 6 : day - 1));
  return d.toISOString().slice(0, 10);
}

/**
 * Record (overwrite) the net realised P&L for a mode on an IST date. ORB is
 * 1-trade/day, so the latest session's net IS the day's result.
 */
function recordDay(mode, isoDate, pnl) {
  const d = _load();
  d.days[`${mode}|${isoDate}`] = parseFloat((Number(pnl) || 0).toFixed(2));
  // prune oldest keys if we somehow exceed MAX_KEEP
  const keys = Object.keys(d.days);
  if (keys.length > MAX_KEEP) {
    keys.sort((a, b) => (a.split("|")[1] < b.split("|")[1] ? -1 : 1));
    for (const k of keys.slice(0, keys.length - MAX_KEEP)) delete d.days[k];
  }
  _save(d);
}

/**
 * PURE scoring core. `daysArr` = [{date, pnl}] for ONE mode. Returns
 * { block, reason?, streak, weekSum }.
 */
function evaluate(daysArr, todayIso, todayPnl, cfg) {
  const prior = daysArr.filter(x => x.date < todayIso).sort((a, b) => (a.date < b.date ? 1 : -1)); // desc
  let streak = 0;
  for (const x of prior) { if (x.pnl < 0) streak++; else break; }
  if (cfg.streakSkip > 0 && streak >= cfg.streakSkip) {
    return { block: true, reason: `${streak} consecutive losing days ≥ ${cfg.streakSkip} — sitting out today (hostile regime)`, streak, weekSum: null };
  }
  const weekStart = _mondayOf(todayIso);
  let weekSum = Number(todayPnl) || 0;
  for (const x of prior) { if (x.date >= weekStart) weekSum += x.pnl; }
  if (cfg.weeklyLoss > 0 && weekSum <= -cfg.weeklyLoss) {
    return { block: true, reason: `Week realised ₹${Math.round(weekSum)} ≤ −₹${cfg.weeklyLoss} — weekly stop hit`, streak, weekSum };
  }
  return { block: false, streak, weekSum };
}

/**
 * Should ORB `mode` sit out today? `todayIso` = IST date, `todayPnl` = today's
 * running realised P&L (added to the week total). Returns { block, reason? }.
 */
function getThrottle(mode, todayIso, todayPnl) {
  if ((process.env.ORB_RISK_THROTTLE_ENABLED || "true").toLowerCase() !== "true") return { block: false };
  const cfg = {
    streakSkip: parseInt(process.env.ORB_LOSS_STREAK_SKIP || "4", 10),
    weeklyLoss: parseFloat(process.env.ORB_MAX_WEEKLY_LOSS || "9000"),
  };
  const d = _load();
  const arr = Object.entries(d.days || {})
    .filter(([k]) => k.startsWith(mode + "|"))
    .map(([k, v]) => ({ date: k.split("|")[1], pnl: Number(v) || 0 }));
  return evaluate(arr, todayIso, todayPnl, cfg);
}

module.exports = { recordDay, getThrottle, evaluate, _mondayOf };

/**
 * consolidatedEodReporter.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Sends one combined end-of-day Telegram report shortly after market close,
 * mirroring the Consolidation page (/consolidation) exactly: same paper-only
 * trade set and the same per-row counting (no live files, no straddle
 * pair-collapse). It computes off that page's loadAllTrades() so the two can
 * never drift — filtered to today.
 *
 * Fires at 15:32 IST, NOT 15:30: the paper engines do their EOD square-off at
 * TRADE_STOP_TIME (15:30), so a 15:30:00 snapshot races those trades onto disk
 * and drops the day's last (often square-off-only) trades. The 2-min buffer lets
 * every square-off trade persist first. See scalpPaper.js / paPaper.js EOD check.
 *
 * Gated by TG_DAYREPORT_CONSOLIDATED (and master TG_ENABLED) inside notify.js.
 * Schedule is idempotent per day — if the server restarts after 15:32, the report
 * for today is skipped (the scheduler only fires going forward).
 */

const { notifyConsolidatedDayReport } = require("./notify");
const { loadAllTrades } = require("../routes/consolidation");

function collectTodayStats(istDate) {
  const byMode = {
    SWING:    { trades: 0, wins: 0, losses: 0, pnl: 0 },
    SCALP:    { trades: 0, wins: 0, losses: 0, pnl: 0 },
    PA:       { trades: 0, wins: 0, losses: 0, pnl: 0 },
    ORB:      { trades: 0, wins: 0, losses: 0, pnl: 0 },
    STRADDLE: { trades: 0, wins: 0, losses: 0, pnl: 0 },
  };

  // loadAllTrades() returns flattened paper trades with `date` = session date
  // sliced to YYYY-MM-DD (IST, as the page stores it) — match it directly.
  for (const t of loadAllTrades()) {
    if (t.date !== istDate) continue;
    const bucket = byMode[t.mode];
    if (!bucket) continue;
    const pnl = Number(t.pnl) || 0;
    bucket.trades++;
    bucket.pnl += pnl;
    if (pnl > 0) bucket.wins++;
    else if (pnl < 0) bucket.losses++;
  }

  // Round P&L to 2dp for display.
  for (const g of Object.keys(byMode)) {
    byMode[g].pnl = parseFloat(byMode[g].pnl.toFixed(2));
  }
  return byMode;
}

function sendConsolidatedReport() {
  try {
    const istDate = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    const byMode  = collectTodayStats(istDate);
    notifyConsolidatedDayReport({ byMode });
  } catch (err) {
    console.error("[EOD] consolidated report failed:", err.message);
  }
}

let _timer = null;

/** Milliseconds until next 15:32 IST. If already past today, schedule for tomorrow.
 *  Fires 2 min after the 15:30 close so EOD square-off trades are persisted first. */
function msUntilNextReportIST() {
  const now = new Date();
  const istNow = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const target = new Date(istNow);
  target.setHours(15, 32, 0, 0);
  let delta = target.getTime() - istNow.getTime();
  if (delta <= 0) delta += 24 * 60 * 60 * 1000; // tomorrow
  return delta;
}

function scheduleNext() {
  if (_timer) clearTimeout(_timer);
  const wait = msUntilNextReportIST();
  _timer = setTimeout(async () => {
    // Only fire on weekdays (Mon–Fri IST). Holidays are a nice-to-have; skipped
    // for now because a muted Telegram toggle already covers them.
    const istNow = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
    const dow = istNow.getDay(); // 0=Sun, 6=Sat
    if (dow !== 0 && dow !== 6) {
      sendConsolidatedReport();
    }
    scheduleNext(); // reschedule for next day
  }, wait);
  // Allow process exit even if this timer is pending
  if (_timer.unref) _timer.unref();
}

function start() {
  scheduleNext();
}

module.exports = { start, sendConsolidatedReport, collectTodayStats };

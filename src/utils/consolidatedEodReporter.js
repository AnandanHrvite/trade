/**
 * consolidatedEodReporter.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Sends one combined end-of-day Telegram report shortly after market close,
 * mirroring the Consolidation page (/consolidation) exactly: same paper-only
 * trade set and the same per-row counting (no live files). It computes off
 * that page's loadAllTrades() so the two can never drift — filtered to today.
 *
 * Fires at 15:32 IST, NOT 15:30: the paper engines do their EOD square-off at
 * TRADE_STOP_TIME (15:30), so a 15:30:00 snapshot races those trades onto disk
 * and drops the day's last (often square-off-only) trades. The 2-min buffer lets
 * every square-off trade persist first. See bbRsiPaper.js / paPaper.js EOD check.
 *
 * Gated by TG_DAYREPORT_CONSOLIDATED (and master TG_ENABLED) inside notify.js.
 *
 * Restart-safe / catch-up: the send is idempotent per day via a persisted
 * "last sent date" at ~/trading-data/.eod_report_state.json. On boot (and on
 * every scheduled tick) we send immediately if it's a trading day, now is at or
 * past 15:32 IST, and today's report has not gone out yet. This survives the
 * routine post-close redeploys (push to main → PM2 restart) that would otherwise
 * silently drop the day's report, since the old in-memory-only timer only fired
 * "going forward" and skipped today on any restart after 15:32.
 */

const fs   = require("fs");
const path = require("path");
const { notifyConsolidatedDayReport } = require("./notify");
const { loadAllTrades } = require("../routes/consolidation");
const { isNonTradingDay } = require("./nseHolidays");

const DATA_DIR   = path.join(require("os").homedir(), "trading-data");
const STATE_FILE = path.join(DATA_DIR, ".eod_report_state.json");

// Report fires at 15:32 IST (2 min after the 15:30 square-off — see header).
const REPORT_HOUR = 15;
const REPORT_MIN  = 32;

function istNow() {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
}

function istDateStr() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

function readLastSentDate() {
  try {
    return (JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) || {}).lastSentDate || null;
  } catch (_) {
    return null;
  }
}

function writeLastSentDate(date) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({ lastSentDate: date }));
  } catch (err) {
    console.warn(`[EOD] could not persist report state: ${err.message}`);
  }
}

function collectTodayStats(istDate) {
  const byMode = {
    EMA_RSI_ST:    { trades: 0, wins: 0, losses: 0, pnl: 0 },
    BB_RSI:    { trades: 0, wins: 0, losses: 0, pnl: 0 },
    PA:       { trades: 0, wins: 0, losses: 0, pnl: 0 },
    ORB:      { trades: 0, wins: 0, losses: 0, pnl: 0 },
    EMA9VWAP: { trades: 0, wins: 0, losses: 0, pnl: 0 },
    TREND_PB: { trades: 0, wins: 0, losses: 0, pnl: 0 },
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

/** Force-send today's report (no idempotency / time / holiday checks).
 *  Exported for manual triggers; returns whatever notify.js reports. */
function sendConsolidatedReport() {
  try {
    const istDate = istDateStr();
    const byMode  = collectTodayStats(istDate);
    return notifyConsolidatedDayReport({ byMode });
  } catch (err) {
    console.error("[EOD] consolidated report failed:", err.message);
    return false;
  }
}

/** Send today's report iff it's a trading day, now ≥ 15:32 IST, and it hasn't
 *  already gone out today. Records the date only on an actual send so a gated-off
 *  toggle (or a transient send failure) is retried on the next boot/tick. */
async function maybeSendForToday() {
  const now     = istNow();
  const istDate = istDateStr();

  // Not yet 15:32 IST today → leave it to the scheduled timer.
  if (now.getHours() < REPORT_HOUR ||
      (now.getHours() === REPORT_HOUR && now.getMinutes() < REPORT_MIN)) {
    return;
  }

  // Already sent today.
  if (readLastSentDate() === istDate) return;

  // Skip weekends and NSE holidays — a row of zeros is not wanted.
  try {
    if (await isNonTradingDay(now)) {
      console.log("[EOD] Non-trading day (weekend/holiday) — skipping consolidated report.");
      return;
    }
  } catch (err) {
    console.warn(`[EOD] holiday check failed (${err.message}) — sending report anyway.`);
  }

  const sent = sendConsolidatedReport();
  if (sent) {
    writeLastSentDate(istDate);
    console.log(`[EOD] consolidated report sent for ${istDate}.`);
  }
}

let _timer = null;

/** Milliseconds until the next 15:32 IST. If already past today, schedule for
 *  tomorrow (today's run is handled by the boot catch-up in start()). */
function msUntilNextReportIST() {
  const now    = istNow();
  const target = new Date(now);
  target.setHours(REPORT_HOUR, REPORT_MIN, 0, 0);
  let delta = target.getTime() - now.getTime();
  if (delta <= 0) delta += 24 * 60 * 60 * 1000; // tomorrow
  return delta;
}

function scheduleNext() {
  if (_timer) clearTimeout(_timer);
  const wait = msUntilNextReportIST();
  _timer = setTimeout(async () => {
    await maybeSendForToday();
    scheduleNext(); // reschedule for next day
  }, wait);
  // Allow process exit even if this timer is pending
  if (_timer.unref) _timer.unref();
}

function start() {
  // Catch-up: if we booted after today's 15:32 and haven't sent yet, send now.
  maybeSendForToday().catch((err) =>
    console.error("[EOD] boot catch-up failed:", err.message));
  scheduleNext();
}

module.exports = { start, sendConsolidatedReport, collectTodayStats };

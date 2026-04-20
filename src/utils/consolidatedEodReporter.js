/**
 * consolidatedEodReporter.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Reads today's persisted trades across all 6 sources (swing/scalp/PA × paper/live)
 * and sends one combined end-of-day Telegram report at 15:30 IST.
 *
 * Gated by TG_DAYREPORT_CONSOLIDATED (and master TG_ENABLED) inside notify.js.
 * Schedule is idempotent per day — if the server restarts after 15:30, the report
 * for today is skipped (the scheduler only fires going forward).
 */

const fs   = require("fs");
const path = require("path");
const os   = require("os");
const { notifyConsolidatedDayReport } = require("./notify");

const DATA_DIR = path.join(os.homedir(), "trading-data");

const SOURCES = [
  { group: "SWING", file: "paper_trades.json"       },
  { group: "SWING", file: "live_trades.json"        },
  { group: "SCALP", file: "scalp_paper_trades.json" },
  { group: "SCALP", file: "scalp_live_trades.json"  },
  { group: "PA",    file: "pa_paper_trades.json"    },
  { group: "PA",    file: "pa_live_trades.json"     },
];

function safeRead(fullPath) {
  try {
    if (!fs.existsSync(fullPath)) return null;
    return JSON.parse(fs.readFileSync(fullPath, "utf-8"));
  } catch (_) {
    return null;
  }
}

function toISTDate(input) {
  if (!input) return "";
  // Accept "YYYY-MM-DD" already or ISO; normalize to IST YYYY-MM-DD.
  // If already a plain YYYY-MM-DD, return as-is (saved as local date, treat as IST).
  if (/^\d{4}-\d{2}-\d{2}$/.test(input)) return input;
  const d = new Date(input);
  if (isNaN(d)) return "";
  return d.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

function collectTodayStats(istDate) {
  const byMode = {
    SWING: { trades: 0, wins: 0, losses: 0, pnl: 0 },
    SCALP: { trades: 0, wins: 0, losses: 0, pnl: 0 },
    PA:    { trades: 0, wins: 0, losses: 0, pnl: 0 },
  };

  for (const src of SOURCES) {
    const data = safeRead(path.join(DATA_DIR, src.file));
    if (!data || !Array.isArray(data.sessions)) continue;

    for (const session of data.sessions) {
      if (toISTDate(session.date) !== istDate) continue;
      const trades = Array.isArray(session.trades) ? session.trades : [];
      for (const t of trades) {
        const pnl = Number(t.pnl) || 0;
        byMode[src.group].trades++;
        byMode[src.group].pnl += pnl;
        if (pnl > 0) byMode[src.group].wins++;
        else if (pnl < 0) byMode[src.group].losses++;
      }
    }
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

/** Milliseconds until next 15:30 IST. If already past today, schedule for tomorrow. */
function msUntilNext1530IST() {
  const now = new Date();
  const istNow = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const target = new Date(istNow);
  target.setHours(15, 30, 0, 0);
  let delta = target.getTime() - istNow.getTime();
  if (delta <= 0) delta += 24 * 60 * 60 * 1000; // tomorrow
  return delta;
}

function scheduleNext() {
  if (_timer) clearTimeout(_timer);
  const wait = msUntilNext1530IST();
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

/**
 * weeklyTradeReporter.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Reads the per-trade JSONL logs for SWING / SCALP / PA, computes the last
 * 7-day window vs the prior 7-day window, and posts one Telegram report.
 *
 * Why JSONL (not the session JSON files used by consolidatedEodReporter):
 *   - Per-trade timestamps via `loggedAt` make day-window slicing trivial.
 *   - Append-only files survive mid-session crashes — better data integrity
 *     for trend analysis.
 *
 * Schedule: Every Monday 20:00 IST.
 * Gate:     TG_WEEKLY_REPORT (master TG_ENABLED still applies).
 *
 * Schedule is idempotent across restarts — only fires going forward.
 */

const fs   = require("fs");
const path = require("path");
const os   = require("os");
const readline = require("readline");
const { notifyWeeklyTradeReport } = require("./notify");

const DATA_DIR = path.join(os.homedir(), "trading-data");

const FILES = [
  { mode: "SWING", file: "paper_trades_log.jsonl"        },
  { mode: "SCALP", file: "scalp_paper_trades_log.jsonl"  },
  { mode: "PA",    file: "pa_paper_trades_log.jsonl"     },
];

const DAY_MS = 24 * 60 * 60 * 1000;

/** Stream a JSONL file and return parsed trade objects. Skips malformed lines. */
async function readJsonl(filePath) {
  return new Promise((resolve) => {
    if (!fs.existsSync(filePath)) return resolve([]);
    const out = [];
    const rl = readline.createInterface({
      input: fs.createReadStream(filePath, "utf-8"),
      crlfDelay: Infinity,
    });
    rl.on("line", (line) => {
      const t = line.trim();
      if (!t) return;
      try { out.push(JSON.parse(t)); } catch (_) { /* skip bad line */ }
    });
    rl.on("close", () => resolve(out));
    rl.on("error", () => resolve(out));
  });
}

/** Pick the trade timestamp ms — prefers `loggedAt` (recorded at exit), falls
 *  back to `exitTimeMs`/`entryBarTime`. Returns null when no usable ts. */
function tradeTimeMs(trade) {
  if (typeof trade.loggedAt === "string") {
    const t = Date.parse(trade.loggedAt);
    if (!isNaN(t)) return t;
  }
  if (typeof trade.exitTimeMs === "number") return trade.exitTimeMs;
  if (typeof trade.entryBarTime === "number") return trade.entryBarTime * 1000;
  return null;
}

/** Aggregate trades into stats: count, wins, losses, winRate, avgWin, avgLoss,
 *  netPnl, lossToWinRatio. avgLoss returned as a positive number for display. */
function summarize(trades) {
  let wins = 0, losses = 0, winSum = 0, lossSum = 0, net = 0;
  for (const t of trades) {
    const pnl = Number(t.pnl);
    if (!isFinite(pnl)) continue;
    net += pnl;
    if (pnl > 0)      { wins++;   winSum  += pnl; }
    else if (pnl < 0) { losses++; lossSum += -pnl; }
  }
  const total   = wins + losses;
  const avgWin  = wins   ? winSum  / wins   : 0;
  const avgLoss = losses ? lossSum / losses : 0;
  const winRate = total  ? (wins / total) * 100 : 0;
  const ratio   = avgWin > 0 ? (avgLoss / avgWin) : null; // null when no winners
  return {
    trades: total,
    wins, losses,
    avgWin:  parseFloat(avgWin.toFixed(2)),
    avgLoss: parseFloat(avgLoss.toFixed(2)),
    netPnl:  parseFloat(net.toFixed(2)),
    winRate: parseFloat(winRate.toFixed(1)),
    ratio:   ratio !== null ? parseFloat(ratio.toFixed(2)) : null,
  };
}

/** Load every JSONL file once and bucket trades into [last 7d] and [prior 7d]
 *  windows, anchored on `nowMs` (defaults to now). */
async function collectWeeklyStats(nowMs) {
  const now    = nowMs || Date.now();
  const lastStart  = now - 7 * DAY_MS;
  const priorStart = now - 14 * DAY_MS;

  const result = {};
  for (const src of FILES) {
    const trades = await readJsonl(path.join(DATA_DIR, src.file));
    const last  = [], prior = [];
    for (const t of trades) {
      const ts = tradeTimeMs(t);
      if (ts === null) continue;
      if (ts >= lastStart && ts <= now)               last.push(t);
      else if (ts >= priorStart && ts < lastStart)    prior.push(t);
    }
    result[src.mode] = { last: summarize(last), prior: summarize(prior) };
  }
  return result;
}

async function sendWeeklyReport() {
  try {
    const byMode = await collectWeeklyStats();
    notifyWeeklyTradeReport({ byMode });
  } catch (err) {
    console.error("[WEEKLY] report failed:", err.message);
  }
}

let _timer = null;

/** Milliseconds until next Monday 20:00 IST. If we're past 20:00 today and it
 *  IS Monday, schedule for next Monday (7 days). */
function msUntilNextMon2000IST() {
  const istNow = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const target = new Date(istNow);
  target.setHours(20, 0, 0, 0);
  // Days until next Monday (1). 0 = today is Mon and we're before 20:00 → fire today.
  let daysUntilMon = (1 - target.getDay() + 7) % 7;
  if (daysUntilMon === 0 && target.getTime() <= istNow.getTime()) daysUntilMon = 7;
  target.setDate(target.getDate() + daysUntilMon);
  return target.getTime() - istNow.getTime();
}

function scheduleNext() {
  if (_timer) clearTimeout(_timer);
  const wait = msUntilNextMon2000IST();
  _timer = setTimeout(async () => {
    await sendWeeklyReport();
    scheduleNext();
  }, wait);
  if (_timer.unref) _timer.unref();
}

function start() {
  scheduleNext();
}

module.exports = { start, sendWeeklyReport, collectWeeklyStats, summarize };

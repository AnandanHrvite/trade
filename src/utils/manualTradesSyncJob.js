/**
 * manualTradesSyncJob.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Daily auto-sync of the user's manual Kite trades. Kite Connect has no
 * historical order/trade endpoint — /trades is transient, today-only — so this
 * is the only way "automatic" can work: pull today's fills once, at a fixed
 * time after close, and let manualTrades.js's dedup make repeat calls a no-op.
 *
 * Same self-rescheduling setTimeout shape as consolidatedEodReporter.js.
 * Fires at 15:35 IST — after the 15:32 consolidated EOD report and comfortably
 * after the 15:30 square-off window, so the day's fills are final.
 *
 * Gated by MANUAL_TRADES_AUTO_SYNC_ENABLED (Settings → Server & Broker). When
 * off, the user still has the "Sync Now" button and CSV import on /pnl-history.
 *
 * Restart-safe / catch-up: idempotent per day via a persisted "last synced
 * date" at ~/trading-data/.manual_sync_state.json — same pattern as the EOD
 * reporter, so a post-close redeploy doesn't skip the day's sync.
 */

const fs = require("fs");
const path = require("path");
const { isNonTradingDay } = require("./nseHolidays");

const DATA_DIR = path.join(require("os").homedir(), "trading-data");
const STATE_FILE = path.join(DATA_DIR, ".manual_sync_state.json");

const SYNC_HOUR = 15;
const SYNC_MIN = 35;

function istNow() {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
}

function istDateStr() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

function readLastSyncedDate() {
  try {
    return (JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) || {}).lastSyncedDate || null;
  } catch (_) {
    return null;
  }
}

function writeLastSyncedDate(date) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({ lastSyncedDate: date }));
  } catch (err) {
    console.warn(`[ManualSync] could not persist sync state: ${err.message}`);
  }
}

function isEnabled() {
  return String(process.env.MANUAL_TRADES_AUTO_SYNC_ENABLED || "false").toLowerCase() === "true";
}

async function maybeSyncForToday() {
  if (!isEnabled()) return;

  const now = istNow();
  const istDate = istDateStr();

  if (now.getHours() < SYNC_HOUR || (now.getHours() === SYNC_HOUR && now.getMinutes() < SYNC_MIN)) return;
  if (readLastSyncedDate() === istDate) return;

  try {
    if (await isNonTradingDay(now)) return;
  } catch (err) {
    console.warn(`[ManualSync] holiday check failed (${err.message}) — syncing anyway.`);
  }

  try {
    const manualTrades = require("./manualTrades");
    const result = await manualTrades.syncFromKite();
    if (result.error) {
      console.warn(`[ManualSync] skipped for ${istDate}: ${result.error}`);
      return; // don't mark as synced — retry next tick/boot so an expired token doesn't silently eat a day
    }
    writeLastSyncedDate(istDate);
    console.log(`[ManualSync] synced ${result.imported} new fill(s) for ${istDate} (${result.skipped} already had).`);
  } catch (err) {
    console.error(`[ManualSync] sync failed: ${err.message}`);
  }
}

let _timer = null;

function msUntilNextSyncIST() {
  const now = istNow();
  const target = new Date(now);
  target.setHours(SYNC_HOUR, SYNC_MIN, 0, 0);
  let delta = target.getTime() - now.getTime();
  if (delta <= 0) delta += 24 * 60 * 60 * 1000;
  return delta;
}

function scheduleNext() {
  if (_timer) clearTimeout(_timer);
  const wait = msUntilNextSyncIST();
  _timer = setTimeout(async () => {
    try { await maybeSyncForToday(); }
    catch (err) { console.error(`[ManualSync] scheduled sync failed: ${(err && err.message) || err}`); }
    finally { scheduleNext(); }
  }, wait);
  if (_timer.unref) _timer.unref();
}

function start() {
  maybeSyncForToday().catch((err) =>
    console.error("[ManualSync] boot catch-up failed:", (err && err.message) || err));
  scheduleNext();
}

module.exports = { start, maybeSyncForToday };

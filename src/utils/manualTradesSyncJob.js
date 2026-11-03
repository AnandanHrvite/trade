/**
 * manualTradesSyncJob.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Daily auto-sync of the user's manual Kite and Fyers trades. Neither broker has
 * a historical trade endpoint — their tradebooks are transient, today-only — so
 * this is the only way "automatic" can work: pull today's fills once, at a fixed
 * time after close, and let manualTrades.js's upsert make repeat calls safe.
 *
 * Same self-rescheduling setTimeout shape as consolidatedEodReporter.js.
 * Fires at 15:35 IST — after the 15:32 consolidated EOD report and comfortably
 * after the 15:30 square-off window, so the day's fills are final.
 *
 * Gated by MANUAL_TRADES_AUTO_SYNC_ENABLED (Settings → Server & Broker). When
 * off, the user still has the "Sync Now" button and CSV import on /pnl-history.
 *
 * Restart-safe / catch-up: idempotent per day and per broker via a persisted
 * "last synced date" at ~/trading-data/.manual_sync_state.json — same pattern as
 * the EOD reporter, so a post-close redeploy doesn't skip the day's sync, and one
 * broker's failed login doesn't hold up the other. A failed broker retries every
 * 15 minutes until midnight IST and raises a Dashboard alert until a sync works.
 */

const fs = require("fs");
const path = require("path");
const { isNonTradingDay } = require("./nseHolidays");

const DATA_DIR = path.join(require("os").homedir(), "trading-data");
const STATE_FILE = path.join(DATA_DIR, ".manual_sync_state.json");

const SYNC_HOUR = 15;
const SYNC_MIN = 35;
const RETRY_MS = 15 * 60 * 1000;

const BROKER_SYNCS = [
  { name: "Kite", stateKey: "lastSyncedDate", run: (manualTrades) => manualTrades.syncFromKite() },
  { name: "Fyers", stateKey: "lastSyncedDateFyers", run: (manualTrades) => manualTrades.syncFromFyers() },
];

function istNow() {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
}

function istDateStr() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

function readSyncState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) || {};
  } catch (_) {
    return {};
  }
}

function patchSyncState(patch) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({ ...readSyncState(), ...patch }));
  } catch (err) {
    console.warn(`[ManualSync] could not persist sync state: ${err.message}`);
  }
}

function isEnabled() {
  return String(process.env.MANUAL_TRADES_AUTO_SYNC_ENABLED || "false").toLowerCase() === "true";
}

// Saves a broker's failed sync for the Dashboard alert; a good sync (no message)
// clears it. Called by the job below and by the Sync Now route.
function recordSyncResult(name, errorMessage) {
  const errors = { ...(readSyncState().errors || {}) };
  if (errorMessage) errors[name] = { message: String(errorMessage), at: new Date().toISOString() };
  else if (errors[name]) delete errors[name];
  else return;
  patchSyncState({ errors });
}

function getSyncErrors() {
  if (!isEnabled()) return [];
  const errors = readSyncState().errors || {};
  return Object.keys(errors).map((broker) => ({ broker, ...errors[broker] }));
}

// Returns true when a broker failed and should be tried again soon.
async function maybeSyncForToday() {
  if (!isEnabled()) return false;

  const now = istNow();
  const istDate = istDateStr();

  if (now.getHours() < SYNC_HOUR || (now.getHours() === SYNC_HOUR && now.getMinutes() < SYNC_MIN)) return false;
  const state = readSyncState();
  const pending = BROKER_SYNCS.filter((s) => state[s.stateKey] !== istDate);
  if (pending.length === 0) return false;

  try {
    if (await isNonTradingDay(now)) return false;
  } catch (err) {
    console.warn(`[ManualSync] holiday check failed (${err.message}) — syncing anyway.`);
  }

  const manualTrades = require("./manualTrades");
  let needsRetry = false;
  for (const sync of pending) {
    try {
      const result = await sync.run(manualTrades);
      if (result.error) {
        console.warn(`[ManualSync] ${sync.name} skipped for ${istDate}: ${result.error}`);
        recordSyncResult(sync.name, result.error);
        needsRetry = true; // don't mark as synced — an expired token mustn't silently eat a day
        continue;
      }
      patchSyncState({ [sync.stateKey]: istDate });
      recordSyncResult(sync.name, null);
      console.log(`[ManualSync] ${sync.name} synced ${result.imported} new fill(s) for ${istDate} (${result.updated} updated).`);
    } catch (err) {
      const message = (err && err.message) || String(err);
      console.error(`[ManualSync] ${sync.name} sync failed: ${message}`);
      recordSyncResult(sync.name, message);
      needsRetry = true;
    }
  }
  return needsRetry;
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

// A failed sync retries every RETRY_MS. Retries end by themselves at midnight IST:
// the new day is before SYNC_HOUR, so maybeSyncForToday() returns false.
function scheduleNext(needsRetry = false) {
  if (_timer) clearTimeout(_timer);
  const wait = needsRetry ? Math.min(RETRY_MS, msUntilNextSyncIST()) : msUntilNextSyncIST();
  _timer = setTimeout(async () => {
    let retry = false;
    try { retry = await maybeSyncForToday(); }
    catch (err) { console.error(`[ManualSync] scheduled sync failed: ${(err && err.message) || err}`); }
    finally { scheduleNext(retry); }
  }, wait);
  if (_timer.unref) _timer.unref();
}

function start() {
  scheduleNext();
  maybeSyncForToday()
    .then((retry) => { if (retry) scheduleNext(true); })
    .catch((err) => console.error("[ManualSync] boot catch-up failed:", (err && err.message) || err));
}

module.exports = { start, maybeSyncForToday, recordSyncResult, getSyncErrors };

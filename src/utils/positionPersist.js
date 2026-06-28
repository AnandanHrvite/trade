/**
 * positionPersist.js — Active trade state persistence (crash recovery)
 * ─────────────────────────────────────────────────────────────────────────────
 * Saves the current active position state to disk so it survives PM2 restarts,
 * OOM kills, and unexpected crashes. On boot, the reconciliation logic in
 * app.js can read this to detect orphaned positions.
 *
 * Files stored at ~/trading-data/ (outside project, survives git pull).
 * ─────────────────────────────────────────────────────────────────────────────
 */

const fs   = require("fs");
const path = require("path");

const DATA_DIR = path.join(require("os").homedir(), "trading-data");

// Ensure directory exists
try { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) {}

// ── Async atomic persist queue (per-file, coalescing) ───────────────────────
// Live SL/trail/breakeven updates fire many times per open position. Doing a
// synchronous writeFileSync on each one blocks the event loop on the tick hot
// path. Instead we queue the latest desired state per file and write it async
// (atomic tmp → rename). If newer state arrives while a write is in flight we
// keep only the newest payload, so a burst of trail updates collapses into one
// or two disk writes. Crash-recovery semantics are unchanged: the file always
// ends up holding the most recently requested state (or absent if cleared).
const _pending = new Map(); // file -> { data: string|null, writing: bool }

function _persistAtomic(file, dataStr /* string to write, or null to delete */) {
  const p = _pending.get(file);
  if (p) { p.data = dataStr; return; }      // coalesce onto in-flight write
  _pending.set(file, { data: dataStr, writing: false });
  _drain(file);
}

function _drain(file) {
  const p = _pending.get(file);
  if (!p || p.writing) return;
  p.writing = true;
  const dataStr = p.data;
  const done = (err) => {
    p.writing = false;
    if (err) {
      // Don't drop the queued state on a transient write error (EIO/ENOSPC) —
      // a lost write here means crash recovery later reads a STALE stop-loss /
      // position. Keep the payload queued and retry with a short backoff.
      p.retries = (p.retries || 0) + 1;
      if (p.retries <= 5) {
        setTimeout(() => _drain(file), 500);
      } else {
        console.warn(`⚠️ [PERSIST] giving up after ${p.retries} write failures: ${file}`);
        _pending.delete(file);
      }
      return;
    }
    p.retries = 0;
    if (p.data !== dataStr) _drain(file);   // newer state arrived mid-write
    else _pending.delete(file);
  };
  if (dataStr === null) {
    fs.unlink(file, (err) => {
      if (err && err.code !== "ENOENT") console.warn(`⚠️ [PERSIST] unlink failed: ${err.message}`);
      done(err && err.code !== "ENOENT" ? err : null);
    });
    return;
  }
  const tmp = file + ".tmp";
  fs.writeFile(tmp, dataStr, "utf-8", (err) => {
    if (err) { console.warn(`⚠️ [PERSIST] write failed: ${err.message}`); return done(err); }
    fs.rename(tmp, file, (err2) => {
      if (err2) console.warn(`⚠️ [PERSIST] rename failed: ${err2.message}`);
      done(err2);
    });
  });
}

// Drain any queued state synchronously. The "exit" event fires right before the
// process terminates (after gracefulShutdown's squareoff completes), so this
// guarantees the most recent position state is durably on disk on every graceful
// shutdown / PM2 restart — matching the old synchronous-write durability.
function _flushSync() {
  for (const [file, p] of _pending) {
    try {
      if (p.data === null) {
        if (fs.existsSync(file)) fs.unlinkSync(file);
      } else {
        const tmp = file + ".tmp";
        fs.writeFileSync(tmp, p.data, "utf-8");
        fs.renameSync(tmp, file);
      }
    } catch (_) { /* best-effort at exit */ }
  }
  _pending.clear();
}
process.on("exit", _flushSync);

// ── Trade (15-min Zerodha) ────────────────────────────────────────────────────

const TRADE_POS_FILE = path.join(DATA_DIR, ".active_trade_position.json");

function saveTradePosition(position, sessionMeta) {
  try {
    if (!position) {
      // Position closed — remove file (queued, coalesces with pending writes)
      _persistAtomic(TRADE_POS_FILE, null);
      return;
    }
    const data = {
      position: {
        side:            position.side,
        symbol:          position.symbol,
        qty:             position.qty,
        entryPrice:      position.entryPrice,
        spotAtEntry:     position.spotAtEntry,
        stopLoss:        position.stopLoss,
        initialStopLoss: position.initialStopLoss,
        bestPrice:       position.bestPrice,
        entryTime:       position.entryTime,
        orderId:         position.orderId,
        optionEntryLtp:  position.optionEntryLtp,
        optionStrike:    position.optionStrike,
        optionExpiry:    position.optionExpiry,
        optionType:      position.optionType,
        trailActivatePts: position.trailActivatePts,
      },
      sessionMeta: sessionMeta || {},
      savedAt: Date.now(),
      savedDate: new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }),
    };
    _persistAtomic(TRADE_POS_FILE, JSON.stringify(data, null, 2));
    console.log(`💾 [PERSIST] Trade position saved: ${position.side} ${position.symbol} @ ₹${position.entryPrice}`);
  } catch (err) {
    console.warn(`⚠️ [PERSIST] Could not save trade position: ${err.message}`);
  }
}

function loadTradePosition() {
  try {
    if (!fs.existsSync(TRADE_POS_FILE)) return null;
    const data = JSON.parse(fs.readFileSync(TRADE_POS_FILE, "utf-8"));
    // Only return if saved today (IST) — stale positions from yesterday are invalid
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    if (data.savedDate && data.savedDate !== today) {
      console.log(`[PERSIST] Stale trade position from ${data.savedDate} — discarding.`);
      fs.unlinkSync(TRADE_POS_FILE);
      return null;
    }
    if (data.position) {
      console.log(`[PERSIST] Trade position loaded: ${data.position.side} ${data.position.symbol} @ ₹${data.position.entryPrice}`);
    }
    return data;
  } catch (err) {
    console.warn(`[PERSIST] Could not load trade position: ${err.message}`);
    return null;
  }
}

function clearTradePosition() {
  _persistAtomic(TRADE_POS_FILE, null);  // queued delete — orders after any pending write
  console.log("[PERSIST] Trade position file cleared.");
}

// ── Scalp (3-min Fyers) ─────────────────────────────────────────────────────

const SCALP_POS_FILE = path.join(DATA_DIR, ".active_scalp_position.json");

function saveScalpPosition(position, sessionMeta) {
  try {
    if (!position) {
      _persistAtomic(SCALP_POS_FILE, null);
      return;
    }
    const data = {
      position: {
        side:            position.side,
        symbol:          position.symbol,
        qty:             position.qty,
        entryPrice:      position.entryPrice,
        spotAtEntry:     position.spotAtEntry,
        stopLoss:        position.stopLoss,
        initialStopLoss: position.initialStopLoss,
        bestPrice:       position.bestPrice,
        entryTime:       position.entryTime,
        orderId:         position.orderId,
        optionEntryLtp:  position.optionEntryLtp,
        optionStrike:    position.optionStrike,
        optionExpiry:    position.optionExpiry,
        optionType:      position.optionType,
      },
      sessionMeta: sessionMeta || {},
      savedAt: Date.now(),
      savedDate: new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }),
    };
    _persistAtomic(SCALP_POS_FILE, JSON.stringify(data, null, 2));
    console.log(`💾 [PERSIST] Scalp position saved: ${position.side} ${position.symbol} @ ₹${position.entryPrice}`);
  } catch (err) {
    console.warn(`⚠️ [PERSIST] Could not save scalp position: ${err.message}`);
  }
}

function loadScalpPosition() {
  try {
    if (!fs.existsSync(SCALP_POS_FILE)) return null;
    const data = JSON.parse(fs.readFileSync(SCALP_POS_FILE, "utf-8"));
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    if (data.savedDate && data.savedDate !== today) {
      console.log(`[PERSIST] Stale scalp position from ${data.savedDate} — discarding.`);
      fs.unlinkSync(SCALP_POS_FILE);
      return null;
    }
    if (data.position) {
      console.log(`[PERSIST] Scalp position loaded: ${data.position.side} ${data.position.symbol} @ ₹${data.position.entryPrice}`);
    }
    return data;
  } catch (err) {
    console.warn(`[PERSIST] Could not load scalp position: ${err.message}`);
    return null;
  }
}

function clearScalpPosition() {
  _persistAtomic(SCALP_POS_FILE, null);
  console.log("[PERSIST] Scalp position file cleared.");
}

// ── Price Action (5-min Fyers) ──────────────────────────────────────────────

const PA_POS_FILE = path.join(DATA_DIR, ".active_pa_position.json");

function savePAPosition(position, sessionMeta) {
  try {
    if (!position) {
      _persistAtomic(PA_POS_FILE, null);
      return;
    }
    const data = {
      position: {
        side:            position.side,
        symbol:          position.symbol,
        qty:             position.qty,
        entryPrice:      position.entryPrice,
        spotAtEntry:     position.spotAtEntry,
        stopLoss:        position.stopLoss,
        initialStopLoss: position.initialStopLoss,
        bestPrice:       position.bestPrice,
        entryTime:       position.entryTime,
        orderId:         position.orderId,
        optionEntryLtp:  position.optionEntryLtp,
        optionStrike:    position.optionStrike,
        optionExpiry:    position.optionExpiry,
        optionType:      position.optionType,
      },
      sessionMeta: sessionMeta || {},
      savedAt: Date.now(),
      savedDate: new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }),
    };
    _persistAtomic(PA_POS_FILE, JSON.stringify(data, null, 2));
    console.log(`💾 [PERSIST] PA position saved: ${position.side} ${position.symbol} @ ₹${position.entryPrice}`);
  } catch (err) {
    console.warn(`⚠️ [PERSIST] Could not save PA position: ${err.message}`);
  }
}

function loadPAPosition() {
  try {
    if (!fs.existsSync(PA_POS_FILE)) return null;
    const data = JSON.parse(fs.readFileSync(PA_POS_FILE, "utf-8"));
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    if (data.savedDate && data.savedDate !== today) {
      console.log(`[PERSIST] Stale PA position from ${data.savedDate} — discarding.`);
      fs.unlinkSync(PA_POS_FILE);
      return null;
    }
    if (data.position) {
      console.log(`[PERSIST] PA position loaded: ${data.position.side} ${data.position.symbol} @ ₹${data.position.entryPrice}`);
    }
    return data;
  } catch (err) {
    console.warn(`[PERSIST] Could not load PA position: ${err.message}`);
    return null;
  }
}

function clearPAPosition() {
  _persistAtomic(PA_POS_FILE, null);
  console.log("[PERSIST] PA position file cleared.");
}

// ── EMA9+VWAP (5-min, Zerodha live via harness) ─────────────────────────────

const EMA9VWAP_POS_FILE = path.join(DATA_DIR, ".active_ema9vwap_position.json");

function saveEma9VwapPosition(position, sessionMeta) {
  try {
    if (!position) {
      _persistAtomic(EMA9VWAP_POS_FILE, null);
      return;
    }
    const data = {
      position: {
        side:            position.side,
        symbol:          position.symbol,
        qty:             position.qty,
        entryPrice:      position.entryPrice,
        spotAtEntry:     position.spotAtEntry,
        stopLoss:        position.stopLoss,
        initialStopLoss: position.initialStopLoss,
        bestPrice:       position.bestPrice,
        entryTime:       position.entryTime,
        orderId:         position.orderId,
        optionEntryLtp:  position.optionEntryLtp,
        optionStrike:    position.optionStrike,
        optionExpiry:    position.optionExpiry,
        optionType:      position.optionType,
      },
      sessionMeta: sessionMeta || {},
      savedAt: Date.now(),
      savedDate: new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }),
    };
    _persistAtomic(EMA9VWAP_POS_FILE, JSON.stringify(data, null, 2));
    console.log(`💾 [PERSIST] EMA9+VWAP position saved: ${position.side} ${position.symbol} @ ₹${position.entryPrice}`);
  } catch (err) {
    console.warn(`⚠️ [PERSIST] Could not save EMA9+VWAP position: ${err.message}`);
  }
}

function loadEma9VwapPosition() {
  try {
    if (!fs.existsSync(EMA9VWAP_POS_FILE)) return null;
    const data = JSON.parse(fs.readFileSync(EMA9VWAP_POS_FILE, "utf-8"));
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    if (data.savedDate && data.savedDate !== today) {
      console.log(`[PERSIST] Stale EMA9+VWAP position from ${data.savedDate} — discarding.`);
      fs.unlinkSync(EMA9VWAP_POS_FILE);
      return null;
    }
    if (data.position) {
      console.log(`[PERSIST] EMA9+VWAP position loaded: ${data.position.side} ${data.position.symbol} @ ₹${data.position.entryPrice}`);
    }
    return data;
  } catch (err) {
    console.warn(`[PERSIST] Could not load EMA9+VWAP position: ${err.message}`);
    return null;
  }
}

function clearEma9VwapPosition() {
  _persistAtomic(EMA9VWAP_POS_FILE, null);
  console.log("[PERSIST] EMA9+VWAP position file cleared.");
}

module.exports = {
  saveTradePosition, loadTradePosition, clearTradePosition,
  saveScalpPosition, loadScalpPosition, clearScalpPosition,
  savePAPosition, loadPAPosition, clearPAPosition,
  saveEma9VwapPosition, loadEma9VwapPosition, clearEma9VwapPosition,
};

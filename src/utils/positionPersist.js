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

// ── Trade (15-min Zerodha) ────────────────────────────────────────────────────

const TRADE_POS_FILE = path.join(DATA_DIR, ".active_trade_position.json");

function saveTradePosition(position, sessionMeta) {
  try {
    if (!position) {
      // Position closed — remove file
      if (fs.existsSync(TRADE_POS_FILE)) fs.unlinkSync(TRADE_POS_FILE);
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
    const tmp = TRADE_POS_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
    fs.renameSync(tmp, TRADE_POS_FILE);  // atomic write
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
  try {
    if (fs.existsSync(TRADE_POS_FILE)) {
      fs.unlinkSync(TRADE_POS_FILE);
      console.log("[PERSIST] Trade position file cleared.");
    }
  } catch (_) {}
}

// ── Scalp (3-min Fyers) ─────────────────────────────────────────────────────

const SCALP_POS_FILE = path.join(DATA_DIR, ".active_scalp_position.json");

function saveScalpPosition(position, sessionMeta) {
  try {
    if (!position) {
      if (fs.existsSync(SCALP_POS_FILE)) fs.unlinkSync(SCALP_POS_FILE);
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
    const tmp = SCALP_POS_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
    fs.renameSync(tmp, SCALP_POS_FILE);
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
  try {
    if (fs.existsSync(SCALP_POS_FILE)) {
      fs.unlinkSync(SCALP_POS_FILE);
      console.log("[PERSIST] Scalp position file cleared.");
    }
  } catch (_) {}
}

module.exports = {
  saveTradePosition, loadTradePosition, clearTradePosition,
  saveScalpPosition, loadScalpPosition, clearScalpPosition,
};

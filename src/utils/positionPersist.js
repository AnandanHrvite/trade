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

const TRADE_POS_FILE = path.join(DATA_DIR, ".active_ema_rsi_st_position.json");

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
        isFutures:       !!position.isFutures,
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

// ── BB_RSI (3-min Fyers) ─────────────────────────────────────────────────────

const BB_RSI_POS_FILE = path.join(DATA_DIR, ".active_bb_rsi_position.json");

function saveBbRsiPosition(position, sessionMeta) {
  try {
    if (!position) {
      _persistAtomic(BB_RSI_POS_FILE, null);
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
        isFutures:       !!position.isFutures,
        optionEntryLtp:  position.optionEntryLtp,
        optionStrike:    position.optionStrike,
        optionExpiry:    position.optionExpiry,
        optionType:      position.optionType,
      },
      sessionMeta: sessionMeta || {},
      savedAt: Date.now(),
      savedDate: new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }),
    };
    _persistAtomic(BB_RSI_POS_FILE, JSON.stringify(data, null, 2));
    console.log(`💾 [PERSIST] BB_RSI position saved: ${position.side} ${position.symbol} @ ₹${position.entryPrice}`);
  } catch (err) {
    console.warn(`⚠️ [PERSIST] Could not save bb_rsi position: ${err.message}`);
  }
}

function loadBbRsiPosition() {
  try {
    if (!fs.existsSync(BB_RSI_POS_FILE)) return null;
    const data = JSON.parse(fs.readFileSync(BB_RSI_POS_FILE, "utf-8"));
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    if (data.savedDate && data.savedDate !== today) {
      console.log(`[PERSIST] Stale bb_rsi position from ${data.savedDate} — discarding.`);
      fs.unlinkSync(BB_RSI_POS_FILE);
      return null;
    }
    if (data.position) {
      console.log(`[PERSIST] BB_RSI position loaded: ${data.position.side} ${data.position.symbol} @ ₹${data.position.entryPrice}`);
    }
    return data;
  } catch (err) {
    console.warn(`[PERSIST] Could not load bb_rsi position: ${err.message}`);
    return null;
  }
}

function clearBbRsiPosition() {
  _persistAtomic(BB_RSI_POS_FILE, null);
  console.log("[PERSIST] BB_RSI position file cleared.");
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
        isFutures:       !!position.isFutures,
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
        isFutures:       !!position.isFutures,
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

// ── ORB (opening-range breakout, Fyers) ─────────────────────────────────────

const ORB_POS_FILE = path.join(DATA_DIR, ".active_orb_position.json");

function saveOrbPosition(position, sessionMeta) {
  try {
    if (!position) { _persistAtomic(ORB_POS_FILE, null); return; }
    const data = {
      position: {
        side:            position.side,
        symbol:          position.symbol,
        qty:             position.qty,
        entryPrice:      position.entryPrice,
        spotAtEntry:     position.spotAtEntry || position.entrySpot,
        stopLoss:        position.stopLoss || position.slSpot,
        initialStopLoss: position.initialStopLoss,
        bestPrice:       position.bestPrice,
        entryTime:       position.entryTime,
        orderId:         position.orderId,
        isFutures:       !!position.isFutures,
        optionEntryLtp:  position.optionEntryLtp,
        optionStrike:    position.optionStrike,
        optionExpiry:    position.optionExpiry,
        optionType:      position.optionType,
      },
      sessionMeta: sessionMeta || {},
      savedAt: Date.now(),
      savedDate: new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }),
    };
    _persistAtomic(ORB_POS_FILE, JSON.stringify(data, null, 2));
    console.log(`💾 [PERSIST] ORB position saved: ${position.side} ${position.symbol} @ ₹${position.entryPrice}`);
  } catch (err) {
    console.warn(`⚠️ [PERSIST] Could not save ORB position: ${err.message}`);
  }
}

function loadOrbPosition() {
  try {
    if (!fs.existsSync(ORB_POS_FILE)) return null;
    const data = JSON.parse(fs.readFileSync(ORB_POS_FILE, "utf-8"));
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    if (data.savedDate && data.savedDate !== today) {
      console.log(`[PERSIST] Stale ORB position from ${data.savedDate} — discarding.`);
      fs.unlinkSync(ORB_POS_FILE);
      return null;
    }
    if (data.position) console.log(`[PERSIST] ORB position loaded: ${data.position.side} ${data.position.symbol} @ ₹${data.position.entryPrice}`);
    return data;
  } catch (err) {
    console.warn(`[PERSIST] Could not load ORB position: ${err.message}`);
    return null;
  }
}

function clearOrbPosition() {
  _persistAtomic(ORB_POS_FILE, null);
  console.log("[PERSIST] ORB position file cleared.");
}

// ── Trend Pullback (5m/15m, Fyers) ──────────────────────────────────────────

const TREND_PB_POS_FILE = path.join(DATA_DIR, ".active_trend_pb_position.json");

function saveTrendPbPosition(position, sessionMeta) {
  try {
    if (!position) { _persistAtomic(TREND_PB_POS_FILE, null); return; }
    const data = {
      position: {
        side:            position.side,
        symbol:          position.symbol,
        qty:             position.qty,
        entryPrice:      position.entryPrice,
        spotAtEntry:     position.spotAtEntry || position.entrySpot,
        stopLoss:        position.stopLoss || position.slSpot,
        initialStopLoss: position.initialStopLoss,
        bestPrice:       position.bestPrice,
        entryTime:       position.entryTime,
        orderId:         position.orderId,
        isFutures:       !!position.isFutures,
        optionEntryLtp:  position.optionEntryLtp,
        optionStrike:    position.optionStrike,
        optionExpiry:    position.optionExpiry,
        optionType:      position.optionType,
      },
      sessionMeta: sessionMeta || {},
      savedAt: Date.now(),
      savedDate: new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }),
    };
    _persistAtomic(TREND_PB_POS_FILE, JSON.stringify(data, null, 2));
    console.log(`💾 [PERSIST] Trend_PB position saved: ${position.side} ${position.symbol} @ ₹${position.entryPrice}`);
  } catch (err) {
    console.warn(`⚠️ [PERSIST] Could not save Trend_PB position: ${err.message}`);
  }
}

function loadTrendPbPosition() {
  try {
    if (!fs.existsSync(TREND_PB_POS_FILE)) return null;
    const data = JSON.parse(fs.readFileSync(TREND_PB_POS_FILE, "utf-8"));
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    if (data.savedDate && data.savedDate !== today) {
      console.log(`[PERSIST] Stale Trend_PB position from ${data.savedDate} — discarding.`);
      fs.unlinkSync(TREND_PB_POS_FILE);
      return null;
    }
    if (data.position) console.log(`[PERSIST] Trend_PB position loaded: ${data.position.side} ${data.position.symbol} @ ₹${data.position.entryPrice}`);
    return data;
  } catch (err) {
    console.warn(`[PERSIST] Could not load Trend_PB position: ${err.message}`);
    return null;
  }
}

function clearTrendPbPosition() {
  _persistAtomic(TREND_PB_POS_FILE, null);
  console.log("[PERSIST] Trend_PB position file cleared.");
}

// ── TREND_DAY_SCALP (5-min, day-gated pullback scalp, Fyers) ─────────────────

const TDS_POS_FILE = path.join(DATA_DIR, ".active_trend_day_scalp_position.json");

function saveTrendDayScalpPosition(position, sessionMeta) {
  try {
    if (!position) { _persistAtomic(TDS_POS_FILE, null); return; }
    const data = {
      position: {
        side:            position.side,
        symbol:          position.symbol,
        qty:             position.qty,
        entryPrice:      position.entryPrice,
        spotAtEntry:     position.spotAtEntry || position.entrySpot,
        stopLoss:        position.stopLoss || position.slSpot,
        initialStopLoss: position.initialStopLoss || position.initialSlSpot,
        // The FULL bracket, so a crash-recovered position reports the real exit
        // levels rather than only the stop. beArmed matters: once armed the stop
        // has already made its one and only move and must not be re-derived.
        target:          position.targetSpot,
        beArmSpot:       position.beArmSpot,
        beStopSpot:      position.beStopSpot,
        beArmed:         !!position.beArmed,
        slPts:           position.slPts,
        targetR:         position.targetR,
        entryUnixSec:    position.entryUnixSec,
        timeStopMins:    position.timeStopMins,
        premiumStopPct:  position.premiumStopPct,
        bestPrice:       position.bestPrice,
        entryTime:       position.entryTime,
        orderId:         position.orderId,
        isFutures:       !!position.isFutures,
        optionEntryLtp:  position.optionEntryLtp,
        optionStrike:    position.optionStrike,
        optionExpiry:    position.optionExpiry,
        optionType:      position.optionType || position.side,
      },
      sessionMeta: sessionMeta || {},
      savedAt: Date.now(),
      savedDate: new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }),
    };
    _persistAtomic(TDS_POS_FILE, JSON.stringify(data, null, 2));
    console.log(`💾 [PERSIST] TREND_DAY_SCALP position saved: ${position.side} ${position.symbol} @ ₹${position.entryPrice}`);
  } catch (err) {
    console.warn(`⚠️ [PERSIST] Could not save TREND_DAY_SCALP position: ${err.message}`);
  }
}

function loadTrendDayScalpPosition() {
  try {
    if (!fs.existsSync(TDS_POS_FILE)) return null;
    const data = JSON.parse(fs.readFileSync(TDS_POS_FILE, "utf-8"));
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    if (data.savedDate && data.savedDate !== today) {
      console.log(`[PERSIST] Stale TREND_DAY_SCALP position from ${data.savedDate} — discarding.`);
      fs.unlinkSync(TDS_POS_FILE);
      return null;
    }
    if (data.position) console.log(`[PERSIST] TREND_DAY_SCALP position loaded: ${data.position.side} ${data.position.symbol} @ ₹${data.position.entryPrice}`);
    return data;
  } catch (err) {
    console.warn(`[PERSIST] Could not load TREND_DAY_SCALP position: ${err.message}`);
    return null;
  }
}

function clearTrendDayScalpPosition() {
  _persistAtomic(TDS_POS_FILE, null);
  console.log("[PERSIST] TREND_DAY_SCALP position file cleared.");
}

// ── HA_SCALP (15-min Heikin Ashi trend scalp, NIFTY 50 spot, Zerodha) ───────
// The stop is a FROZEN raw price level and there is no target and no trail, so
// a crash-recovered position can be reconstructed exactly — there is no
// ratchet state to lose. The Heikin Ashi context is stored alongside so the
// recovery log can say WHICH candle opened the trade.

const HA_SCALP_POS_FILE = path.join(DATA_DIR, ".active_ha_scalp_position.json");

function saveHaScalpPosition(position, sessionMeta) {
  try {
    if (!position) { _persistAtomic(HA_SCALP_POS_FILE, null); return; }
    const data = {
      position: {
        side:            position.side,
        symbol:          position.symbol,
        qty:             position.qty,
        entryPrice:      position.entryPrice,
        spotAtEntry:     position.spotAtEntry || position.entrySpot,
        stopLoss:        position.stopLoss || position.slSpot,
        initialStopLoss: position.initialStopLoss || position.initialSlSpot,
        target:          null,   // HA_SCALP has no target, by design
        slPts:           position.slPts,
        trend:           position.trend,
        ma:              position.ma,
        maType:          position.maType,
        haOpen:          position.haOpen,
        haHigh:          position.haHigh,
        haLow:           position.haLow,
        haClose:         position.haClose,
        bodyPct:         position.bodyPct,
        upperWickPct:    position.upperWickPct,
        lowerWickPct:    position.lowerWickPct,
        signalRawHigh:   position.signalRawHigh,
        signalRawLow:    position.signalRawLow,
        signalBarTime:   position.signalBarTime,
        entryUnixSec:    position.entryUnixSec,
        entryTime:       position.entryTime,
        orderId:         position.orderId,
        isFutures:       !!position.isFutures,
        optionEntryLtp:  position.optionEntryLtp,
        optionStrike:    position.optionStrike,
        optionExpiry:    position.optionExpiry,
        optionType:      position.optionType || position.side,
      },
      sessionMeta: sessionMeta || {},
      savedAt: Date.now(),
      savedDate: new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }),
    };
    _persistAtomic(HA_SCALP_POS_FILE, JSON.stringify(data, null, 2));
    console.log(`💾 [PERSIST] HA_SCALP position saved: ${position.side} ${position.symbol} @ ₹${position.entryPrice}`);
  } catch (err) {
    console.warn(`⚠️ [PERSIST] Could not save HA_SCALP position: ${err.message}`);
  }
}

function loadHaScalpPosition() {
  try {
    if (!fs.existsSync(HA_SCALP_POS_FILE)) return null;
    const data = JSON.parse(fs.readFileSync(HA_SCALP_POS_FILE, "utf-8"));
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    if (data.savedDate && data.savedDate !== today) {
      console.log(`[PERSIST] Stale HA_SCALP position from ${data.savedDate} — discarding.`);
      fs.unlinkSync(HA_SCALP_POS_FILE);
      return null;
    }
    if (data.position) console.log(`[PERSIST] HA_SCALP position loaded: ${data.position.side} ${data.position.symbol} @ ₹${data.position.entryPrice}`);
    return data;
  } catch (err) {
    console.warn(`[PERSIST] Could not load HA_SCALP position: ${err.message}`);
    return null;
  }
}

function clearHaScalpPosition() {
  _persistAtomic(HA_SCALP_POS_FILE, null);
  console.log("[PERSIST] HA_SCALP position file cleared.");
}


// ── RSI_PIVOT_ST (RSI + pivot breakout + SuperTrend stop, Zerodha) ──────────
// The stop is a FROZEN price at entry (SuperTrend level + premium floor), so a
// crash-recovered position can be reconstructed exactly: there is no trail
// state and no breakeven flag to lose.

const RSI_PIVOT_ST_POS_FILE = path.join(DATA_DIR, ".active_rsi_pivot_st_position.json");

function saveRsiPivotStPosition(position, sessionMeta) {
  try {
    if (!position) { _persistAtomic(RSI_PIVOT_ST_POS_FILE, null); return; }
    const data = {
      position: {
        side:            position.side,
        symbol:          position.symbol,
        qty:             position.qty,
        entryPrice:      position.entryPrice,
        spotAtEntry:     position.spotAtEntry || position.entrySpot,
        stopLoss:        position.stopLoss || position.slSpot,
        initialStopLoss: position.initialStopLoss || position.initialSlSpot,
        target:          position.targetSpot,
        slPts:           position.slPts,
        targetPts:       position.targetPts,
        rr:              position.rr,
        signalStrength:  position.signalStrength,
        crossedLevel:    position.crossedLevel,
        pp:              position.pp,
        r1:              position.r1,
        s1:              position.s1,
        entryUnixSec:    position.entryUnixSec,
        entryTime:       position.entryTime,
        orderId:         position.orderId,
        isFutures:       !!position.isFutures,
        optionEntryLtp:  position.optionEntryLtp,
        optionStrike:    position.optionStrike,
        optionExpiry:    position.optionExpiry,
        optionType:      position.optionType || position.side,
        // The premium floor is the second (and on PE the only) stop, and it
        // RATCHETS — recovery must resume on the floor already reached, not
        // re-derive it from the entry. null is meaningful: it records that this
        // side does not carry a premium stop at all.
        premiumFloor:        position.premiumFloor != null ? position.premiumFloor : null,
        initialPremiumFloor: position.initialPremiumFloor != null ? position.initialPremiumFloor : null,
        peakPremium:         position.peakPremium,
        premiumStopPct:      position.premiumStopPct,
        premiumStopSides:    position.premiumStopSides,
        premiumStopApplies:  position.premiumStopApplies,
      },
      sessionMeta: sessionMeta || {},
      savedAt: Date.now(),
      savedDate: new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }),
    };
    _persistAtomic(RSI_PIVOT_ST_POS_FILE, JSON.stringify(data, null, 2));
    console.log(`💾 [PERSIST] RSI_PIVOT_ST position saved: ${position.side} ${position.symbol} @ ₹${position.entryPrice}`);
  } catch (err) {
    console.warn(`⚠️ [PERSIST] Could not save RSI_PIVOT_ST position: ${err.message}`);
  }
}

function loadRsiPivotStPosition() {
  try {
    if (!fs.existsSync(RSI_PIVOT_ST_POS_FILE)) return null;
    const data = JSON.parse(fs.readFileSync(RSI_PIVOT_ST_POS_FILE, "utf-8"));
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    if (data.savedDate && data.savedDate !== today) {
      console.log(`[PERSIST] Stale RSI_PIVOT_ST position from ${data.savedDate} — discarding.`);
      fs.unlinkSync(RSI_PIVOT_ST_POS_FILE);
      return null;
    }
    if (data.position) console.log(`[PERSIST] RSI_PIVOT_ST position loaded: ${data.position.side} ${data.position.symbol} @ ₹${data.position.entryPrice}`);
    return data;
  } catch (err) {
    console.warn(`[PERSIST] Could not load RSI_PIVOT_ST position: ${err.message}`);
    return null;
  }
}

function clearRsiPivotStPosition() {
  _persistAtomic(RSI_PIVOT_ST_POS_FILE, null);
  console.log("[PERSIST] RSI_PIVOT_ST position file cleared.");
}


// ── BN_PIVOT_RSI_ST (RSI + pivot breakout + SuperTrend stop, NIFTY BANK, Zerodha) ─
// Byte-for-byte the RSI_PIVOT_ST block above on a different underlying and a
// different file, so a NIFTY and a NIFTY BANK position can be persisted and
// recovered at the same time without one overwriting the other. Same persisted
// fields: SuperTrend stop, the ratcheting premium floor and its peak, pivots.
// The stop is a FROZEN price at entry (SuperTrend level + premium floor), so a
// crash-recovered position can be reconstructed exactly: there is no trail
// state and no breakeven flag to lose.

const BN_PIVOT_RSI_ST_POS_FILE = path.join(DATA_DIR, ".active_bn_pivot_rsi_st_position.json");

function saveBnPivotRsiStPosition(position, sessionMeta) {
  try {
    if (!position) { _persistAtomic(BN_PIVOT_RSI_ST_POS_FILE, null); return; }
    const data = {
      position: {
        side:            position.side,
        symbol:          position.symbol,
        qty:             position.qty,
        entryPrice:      position.entryPrice,
        spotAtEntry:     position.spotAtEntry || position.entrySpot,
        stopLoss:        position.stopLoss || position.slSpot,
        initialStopLoss: position.initialStopLoss || position.initialSlSpot,
        target:          position.targetSpot,
        slPts:           position.slPts,
        targetPts:       position.targetPts,
        rr:              position.rr,
        signalStrength:  position.signalStrength,
        crossedLevel:    position.crossedLevel,
        pp:              position.pp,
        r1:              position.r1,
        s1:              position.s1,
        entryUnixSec:    position.entryUnixSec,
        entryTime:       position.entryTime,
        orderId:         position.orderId,
        isFutures:       !!position.isFutures,
        optionEntryLtp:  position.optionEntryLtp,
        optionStrike:    position.optionStrike,
        optionExpiry:    position.optionExpiry,
        optionType:      position.optionType || position.side,
        // The premium floor is the second (and on PE the only) stop, and it
        // RATCHETS — recovery must resume on the floor already reached, not
        // re-derive it from the entry. null is meaningful: it records that this
        // side does not carry a premium stop at all.
        premiumFloor:        position.premiumFloor != null ? position.premiumFloor : null,
        initialPremiumFloor: position.initialPremiumFloor != null ? position.initialPremiumFloor : null,
        peakPremium:         position.peakPremium,
        premiumStopPct:      position.premiumStopPct,
        premiumStopSides:    position.premiumStopSides,
        premiumStopApplies:  position.premiumStopApplies,
      },
      sessionMeta: sessionMeta || {},
      savedAt: Date.now(),
      savedDate: new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }),
    };
    _persistAtomic(BN_PIVOT_RSI_ST_POS_FILE, JSON.stringify(data, null, 2));
    console.log(`💾 [PERSIST] BN_PIVOT_RSI_ST (NIFTY BANK) position saved: ${position.side} ${position.symbol} @ ₹${position.entryPrice}`);
  } catch (err) {
    console.warn(`⚠️ [PERSIST] Could not save BN_PIVOT_RSI_ST (NIFTY BANK) position: ${err.message}`);
  }
}

function loadBnPivotRsiStPosition() {
  try {
    if (!fs.existsSync(BN_PIVOT_RSI_ST_POS_FILE)) return null;
    const data = JSON.parse(fs.readFileSync(BN_PIVOT_RSI_ST_POS_FILE, "utf-8"));
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    if (data.savedDate && data.savedDate !== today) {
      console.log(`[PERSIST] Stale BN_PIVOT_RSI_ST (NIFTY BANK) position from ${data.savedDate} — discarding.`);
      fs.unlinkSync(BN_PIVOT_RSI_ST_POS_FILE);
      return null;
    }
    if (data.position) console.log(`[PERSIST] BN_PIVOT_RSI_ST (NIFTY BANK) position loaded: ${data.position.side} ${data.position.symbol} @ ₹${data.position.entryPrice}`);
    return data;
  } catch (err) {
    console.warn(`[PERSIST] Could not load BN_PIVOT_RSI_ST (NIFTY BANK) position: ${err.message}`);
    return null;
  }
}

function clearBnPivotRsiStPosition() {
  _persistAtomic(BN_PIVOT_RSI_ST_POS_FILE, null);
  console.log("[PERSIST] BN_PIVOT_RSI_ST (NIFTY BANK) position file cleared.");
}

// ── SIMPLE_9:30 (09:25 ITM pick, premium-trigger entry, Zerodha) ────────────
// Unlike the frozen-price strategies above, this one DOES
// carry live trail state: `stop` ratchets up behind `peak` on every new premium
// high, and the sideways band decides at 09:45 whether the trade is left alone
// or closed. The frozen entry levels alone are therefore NOT enough — the trail
// fields (peak / trough / trailMoves / stop / trailArmed / trailArmAtBandUp)
// and the band fields (bandUp / bandDown / expanded / expandedAt) are what make
// a crash-recovered position reconstructable: without them a restart would wind
// the stop back to initialStop and re-arm a sideways check that has already
// fired.
// entryPrice / optionEntryLtp are OPTION PREMIUMS — the premium is the traded
// price every level of this strategy is measured on.

const SIMPLE930_POS_FILE = path.join(DATA_DIR, ".active_simple930_position.json");

function saveSimple930Position(position, sessionMeta) {
  try {
    if (!position) { _persistAtomic(SIMPLE930_POS_FILE, null); return; }
    const data = {
      position: {
        side:            position.side,
        symbol:          position.symbol,
        optionStrike:    position.optionStrike,
        optionExpiry:    position.optionExpiry,
        optionType:      position.optionType || position.side,
        qty:             position.qty,
        isFutures:       !!position.isFutures,
        optionEntryLtp:  position.optionEntryLtp,
        entryPrice:      position.entryPrice,
        spotAtEntry:     position.spotAtEntry,
        indexAtEntry:    position.indexAtEntry,
        atmAtSelection:  position.atmAtSelection,
        selectionLtp:    position.selectionLtp,
        trigger:         position.trigger,
        stop:            position.stop,
        stopLoss:        position.stopLoss,
        initialStop:     position.initialStop,
        initialStopLoss: position.initialStopLoss,
        slPts:           position.slPts,
        trailPts:        position.trailPts,
        trailEnabled:    position.trailEnabled,
        // The trail is parked until the premium touches bandUp. Both fields are
        // frozen on the position, so both must survive the restart — otherwise a
        // recovered trade re-reads live config and can arm (or dis-arm) itself
        // on a rule the trade was never opened under.
        trailArmAtBandUp: position.trailArmAtBandUp,
        trailArmed:      position.trailArmed,
        trailMoves:      position.trailMoves,
        bandUp:          position.bandUp,
        bandDown:        position.bandDown,
        expanded:        position.expanded,
        expandedAt:      position.expandedAt,
        peak:            position.peak,
        trough:          position.trough,
        entryTime:       position.entryTime,
        entryMin:        position.entryMin,
        entryTimeMs:     position.entryTimeMs,
        entryUnixSec:    position.entryUnixSec,
        entryBarTime:    position.entryBarTime,
        entryReason:     position.entryReason,
      },
      sessionMeta: sessionMeta || {},
      savedAt: Date.now(),
      savedDate: new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }),
    };
    _persistAtomic(SIMPLE930_POS_FILE, JSON.stringify(data, null, 2));
    console.log(`💾 [PERSIST] SIMPLE_9:30 position saved: ${position.side} ${position.symbol} @ ₹${position.entryPrice}`);
  } catch (err) {
    console.warn(`⚠️ [PERSIST] Could not save SIMPLE_9:30 position: ${err.message}`);
  }
}

function loadSimple930Position() {
  try {
    if (!fs.existsSync(SIMPLE930_POS_FILE)) return null;
    const data = JSON.parse(fs.readFileSync(SIMPLE930_POS_FILE, "utf-8"));
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    if (data.savedDate && data.savedDate !== today) {
      console.log(`[PERSIST] Stale SIMPLE_9:30 position from ${data.savedDate} — discarding.`);
      fs.unlinkSync(SIMPLE930_POS_FILE);
      return null;
    }
    if (data.position) console.log(`[PERSIST] SIMPLE_9:30 position loaded: ${data.position.side} ${data.position.symbol} @ ₹${data.position.entryPrice}`);
    return data;
  } catch (err) {
    console.warn(`[PERSIST] Could not load SIMPLE_9:30 position: ${err.message}`);
    return null;
  }
}

function clearSimple930Position() {
  _persistAtomic(SIMPLE930_POS_FILE, null);
  console.log("[PERSIST] SIMPLE_9:30 position file cleared.");
}

// ── EARLY_BIRD (first-15-min cash-equity breakout, F&O stocks, Fyers) ────────
// UNLIKE EVERY OTHER STRATEGY HERE this one holds MANY positions at once — one
// per confirming stock, up to EARLYBIRD_MAX_CONCURRENT. So the snapshot stores
// an ARRAY, and the load/clear helpers speak arrays too. A caller that expects
// a single `position` object will get `positions: []` and must be updated, not
// worked around.
//
// Every level (entry, stop, target) is FROZEN at 09:30 and never moves — there
// is no trail and no breakeven — so a crash-recovered position needs no ratchet
// state. The pending (not-yet-triggered) setups are stored alongside, because
// losing them on a restart would silently cancel the day's remaining orders.
//
// These are CASH EQUITY positions: `qty` is a share count, not a lot, and a
// SHORT is a real intraday short sale. There is no strike, expiry or option LTP.

const EARLY_BIRD_POS_FILE = path.join(DATA_DIR, ".active_early_bird_position.json");

function _ebLevels(p) {
  return {
    symbol:        p.symbol,
    fyersSymbol:   p.fyersSymbol,
    side:          p.side,                 // "LONG" | "SHORT"
    qty:           p.qty,
    entryPrice:    p.entryPrice,
    stop:          p.stop,
    target:        p.target,
    riskPts:       p.riskPts,
    rewardPts:     p.rewardPts,
    bigCandle:     p.bigCandle,
    slBasis:       p.slBasis,
    gapPct:        p.gapPct,
    prevClose:     p.prevClose,
    shape:         p.shape,
    signalOpen:    p.signalOpen,
    signalHigh:    p.signalHigh,
    signalLow:     p.signalLow,
    signalClose:   p.signalClose,
    signalBarTime: p.signalBarTime,
    entryUnixSec:  p.entryUnixSec,
    entryTime:     p.entryTime,
    orderId:       p.orderId,
  };
}

function saveEarlyBirdPositions(positions, sessionMeta, pendingSetups) {
  try {
    const list = Array.isArray(positions) ? positions.filter(Boolean) : [];
    const pend = Array.isArray(pendingSetups) ? pendingSetups.filter(Boolean) : [];
    // The OPTION leg (EARLYBIRD_TRADE_MODE=option|both) lives in sessionMeta,
    // NOT in the two arrays above — those are normalised to cash-equity levels
    // by _ebLevels, which would strip an option's strike, expiry and premium.
    // So "nothing to save" has to account for it: in option-ONLY mode both
    // arrays are legitimately empty while a real position is open, and deleting
    // the file there would lose the only snapshot of it.
    const meta = sessionMeta || {};
    const hasOption = !!(meta.optionPosition || meta.optionPending);
    if (!list.length && !pend.length && !hasOption) { _persistAtomic(EARLY_BIRD_POS_FILE, null); return; }
    const data = {
      positions:   list.map(_ebLevels),
      pendingSetups: pend.map(_ebLevels),
      sessionMeta: meta,
      savedAt:     Date.now(),
      savedDate:   new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }),
    };
    _persistAtomic(EARLY_BIRD_POS_FILE, JSON.stringify(data, null, 2));
    const optNote = meta.optionPosition
      ? ` — OPTION ${meta.optionPosition.side} ${meta.optionPosition.qty}×${meta.optionPosition.symbol}@₹${meta.optionPosition.optionEntryLtp}`
      : meta.optionPending ? " — 1 pending OPTION setup" : "";
    console.log(`💾 [PERSIST] EARLY_BIRD saved: ${list.length} open position(s), ${pend.length} pending setup(s)` +
      (list.length ? ` — ${list.map(p => `${p.side} ${p.qty}×${p.symbol}@₹${p.entryPrice}`).join(", ")}` : "") + optNote);
  } catch (err) {
    console.warn(`⚠️ [PERSIST] Could not save EARLY_BIRD positions: ${err.message}`);
  }
}

function loadEarlyBirdPositions() {
  try {
    if (!fs.existsSync(EARLY_BIRD_POS_FILE)) return null;
    const data = JSON.parse(fs.readFileSync(EARLY_BIRD_POS_FILE, "utf-8"));
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    if (data.savedDate && data.savedDate !== today) {
      console.log(`[PERSIST] Stale EARLY_BIRD snapshot from ${data.savedDate} — discarding.`);
      fs.unlinkSync(EARLY_BIRD_POS_FILE);
      return null;
    }
    // Normalise: an older/partial file must never hand back undefined arrays.
    if (!Array.isArray(data.positions))     data.positions = [];
    if (!Array.isArray(data.pendingSetups)) data.pendingSetups = [];
    if (data.positions.length) {
      console.log(`[PERSIST] EARLY_BIRD loaded ${data.positions.length} open position(s): ` +
        data.positions.map(p => `${p.side} ${p.qty}×${p.symbol}@₹${p.entryPrice}`).join(", "));
    }
    if (data.pendingSetups.length) {
      console.log(`[PERSIST] EARLY_BIRD loaded ${data.pendingSetups.length} pending setup(s): ` +
        data.pendingSetups.map(p => `${p.side} ${p.symbol}@₹${p.entryPrice}`).join(", "));
    }
    return data;
  } catch (err) {
    console.warn(`[PERSIST] Could not load EARLY_BIRD positions: ${err.message}`);
    return null;
  }
}

function clearEarlyBirdPositions() {
  _persistAtomic(EARLY_BIRD_POS_FILE, null);
  console.log("[PERSIST] EARLY_BIRD position file cleared.");
}


module.exports = {
  saveTradePosition, loadTradePosition, clearTradePosition,
  saveBbRsiPosition, loadBbRsiPosition, clearBbRsiPosition,
  savePAPosition, loadPAPosition, clearPAPosition,
  saveEma9VwapPosition, loadEma9VwapPosition, clearEma9VwapPosition,
  saveOrbPosition, loadOrbPosition, clearOrbPosition,
  saveTrendPbPosition, loadTrendPbPosition, clearTrendPbPosition,
  saveTrendDayScalpPosition, loadTrendDayScalpPosition, clearTrendDayScalpPosition,
  saveHaScalpPosition, loadHaScalpPosition, clearHaScalpPosition,
  saveEarlyBirdPositions, loadEarlyBirdPositions, clearEarlyBirdPositions,
  saveRsiPivotStPosition, loadRsiPivotStPosition, clearRsiPivotStPosition,
  saveBnPivotRsiStPosition, loadBnPivotRsiStPosition, clearBnPivotRsiStPosition,
  saveSimple930Position, loadSimple930Position, clearSimple930Position,
};

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

// ── GAPS (daily signal, intraday exits, Fyers) ───────────────────────────────

const GAPS_POS_FILE = path.join(DATA_DIR, ".active_gaps_position.json");

function saveGapsPosition(position, sessionMeta) {
  try {
    if (!position) { _persistAtomic(GAPS_POS_FILE, null); return; }
    const data = {
      position: {
        side:            position.side,
        symbol:          position.symbol,
        qty:             position.qty,
        entryPrice:      position.entryPrice,
        spotAtEntry:     position.spotAtEntry || position.entrySpot,
        stopLoss:        position.stopLoss || position.slSpot,
        initialStopLoss: position.initialStopLoss || position.initialSlSpot,
        // GAPS exits on a trailing EMA, not a fixed target. Persist where the
        // trail sat so a crash-recovered position reports the real exit level.
        trailSpot:       position.trailSpot,
        trailLength:     position.trailLength,
        bestPrice:       position.bestPrice,
        entryTime:       position.entryTime,
        orderId:         position.orderId,
        optionEntryLtp:  position.optionEntryLtp,
        optionStrike:    position.optionStrike,
        optionExpiry:    position.optionExpiry,
        optionType:      position.optionType || position.side,
      },
      sessionMeta: sessionMeta || {},
      savedAt: Date.now(),
      savedDate: new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }),
    };
    _persistAtomic(GAPS_POS_FILE, JSON.stringify(data, null, 2));
    console.log(`💾 [PERSIST] GAPS position saved: ${position.side} ${position.symbol} @ ₹${position.entryPrice}`);
  } catch (err) {
    console.warn(`⚠️ [PERSIST] Could not save GAPS position: ${err.message}`);
  }
}

function loadGapsPosition() {
  try {
    if (!fs.existsSync(GAPS_POS_FILE)) return null;
    const data = JSON.parse(fs.readFileSync(GAPS_POS_FILE, "utf-8"));
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    if (data.savedDate && data.savedDate !== today) {
      console.log(`[PERSIST] Stale GAPS position from ${data.savedDate} — discarding.`);
      fs.unlinkSync(GAPS_POS_FILE);
      return null;
    }
    if (data.position) console.log(`[PERSIST] GAPS position loaded: ${data.position.side} ${data.position.symbol} @ ₹${data.position.entryPrice}`);
    return data;
  } catch (err) {
    console.warn(`[PERSIST] Could not load GAPS position: ${err.message}`);
    return null;
  }
}

function clearGapsPosition() {
  _persistAtomic(GAPS_POS_FILE, null);
  console.log("[PERSIST] GAPS position file cleared.");
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

// ── 3M_GAP_FIX_SCALP (3-min NIFTY futures gap fade, Fyers) ──────────────────
// Both exit levels are FROZEN prices, so a crash-recovered position can be
// reconstructed exactly: there is no trail state and no breakeven flag to lose.
// entryPrice / spotAtEntry are FUTURES prices — that is the instrument every
// level of this strategy is measured on.

const GAP3M_POS_FILE = path.join(DATA_DIR, ".active_gap_fix_3m_position.json");

function saveGapFix3mPosition(position, sessionMeta) {
  try {
    if (!position) { _persistAtomic(GAP3M_POS_FILE, null); return; }
    const data = {
      position: {
        side:            position.side,
        symbol:          position.symbol,
        qty:             position.qty,
        entryPrice:      position.entryPrice,
        spotAtEntry:     position.spotAtEntry || position.entrySpot,
        indexAtEntry:    position.indexAtEntry,
        futuresSymbol:   position.futuresSymbol,
        stopLoss:        position.stopLoss || position.slSpot,
        initialStopLoss: position.initialStopLoss || position.initialSlSpot,
        target:          position.targetSpot,
        slPts:           position.slPts,
        targetPts:       position.targetPts,
        rr:              position.rr,
        gapDir:          position.gapDir,
        gapSize:         position.gapSize,
        gapTop:          position.gapTop,
        gapBottom:       position.gapBottom,
        gapFillLevel:    position.gapFillLevel,
        dayHighAtEntry:  position.dayHighAtEntry,
        dayLowAtEntry:   position.dayLowAtEntry,
        entryUnixSec:    position.entryUnixSec,
        entryTime:       position.entryTime,
        orderId:         position.orderId,
        optionEntryLtp:  position.optionEntryLtp,
        optionStrike:    position.optionStrike,
        optionExpiry:    position.optionExpiry,
        optionType:      position.optionType || position.side,
      },
      sessionMeta: sessionMeta || {},
      savedAt: Date.now(),
      savedDate: new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }),
    };
    _persistAtomic(GAP3M_POS_FILE, JSON.stringify(data, null, 2));
    console.log(`💾 [PERSIST] 3M_GAP_FIX_SCALP position saved: ${position.side} ${position.symbol} @ ₹${position.entryPrice}`);
  } catch (err) {
    console.warn(`⚠️ [PERSIST] Could not save 3M_GAP_FIX_SCALP position: ${err.message}`);
  }
}

function loadGapFix3mPosition() {
  try {
    if (!fs.existsSync(GAP3M_POS_FILE)) return null;
    const data = JSON.parse(fs.readFileSync(GAP3M_POS_FILE, "utf-8"));
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    if (data.savedDate && data.savedDate !== today) {
      console.log(`[PERSIST] Stale 3M_GAP_FIX_SCALP position from ${data.savedDate} — discarding.`);
      fs.unlinkSync(GAP3M_POS_FILE);
      return null;
    }
    if (data.position) console.log(`[PERSIST] 3M_GAP_FIX_SCALP position loaded: ${data.position.side} ${data.position.symbol} @ ₹${data.position.entryPrice}`);
    return data;
  } catch (err) {
    console.warn(`[PERSIST] Could not load 3M_GAP_FIX_SCALP position: ${err.message}`);
    return null;
  }
}

function clearGapFix3mPosition() {
  _persistAtomic(GAP3M_POS_FILE, null);
  console.log("[PERSIST] 3M_GAP_FIX_SCALP position file cleared.");
}

// ── OI_WALL_FADE (per-strike OI wall fade, Fyers) ───────────────────────────
// Both exit levels are FROZEN prices, so a crash-recovered position can be
// reconstructed exactly: there is no trail state and no breakeven flag to lose.
// The wall context is persisted alongside them because the LADDER IS NOT
// RECOVERABLE — oiChain is in-memory and starts empty after a restart, so
// without these fields a recovered position could not even say what it was
// fading. No exit reads them; they exist so the reconciliation Telegram and the
// trade record can.

const OIWF_POS_FILE = path.join(DATA_DIR, ".active_oi_wall_fade_position.json");

function saveOiWallFadePosition(position, sessionMeta) {
  try {
    if (!position) { _persistAtomic(OIWF_POS_FILE, null); return; }
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
        wallStrike:      position.wallStrike,
        wallSide:        position.wallSide,
        wallOi:          position.wallOi,
        wallDeltaPct:    position.wallDeltaPct,
        ceWallStrike:    position.ceWallStrike,
        peWallStrike:    position.peWallStrike,
        bandLo:          position.bandLo,
        bandHi:          position.bandHi,
        bandMid:         position.bandMid,
        bandPts:         position.bandPts,
        entryUnixSec:    position.entryUnixSec,
        entryTime:       position.entryTime,
        orderId:         position.orderId,
        optionEntryLtp:  position.optionEntryLtp,
        optionStrike:    position.optionStrike,
        optionExpiry:    position.optionExpiry,
        optionType:      position.optionType || position.side,
      },
      sessionMeta: sessionMeta || {},
      savedAt: Date.now(),
      savedDate: new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }),
    };
    _persistAtomic(OIWF_POS_FILE, JSON.stringify(data, null, 2));
    console.log(`💾 [PERSIST] OI_WALL_FADE position saved: ${position.side} ${position.symbol} @ ₹${position.entryPrice}`);
  } catch (err) {
    console.warn(`⚠️ [PERSIST] Could not save OI_WALL_FADE position: ${err.message}`);
  }
}

function loadOiWallFadePosition() {
  try {
    if (!fs.existsSync(OIWF_POS_FILE)) return null;
    const data = JSON.parse(fs.readFileSync(OIWF_POS_FILE, "utf-8"));
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    if (data.savedDate && data.savedDate !== today) {
      console.log(`[PERSIST] Stale OI_WALL_FADE position from ${data.savedDate} — discarding.`);
      fs.unlinkSync(OIWF_POS_FILE);
      return null;
    }
    if (data.position) console.log(`[PERSIST] OI_WALL_FADE position loaded: ${data.position.side} ${data.position.symbol} @ ₹${data.position.entryPrice}`);
    return data;
  } catch (err) {
    console.warn(`[PERSIST] Could not load OI_WALL_FADE position: ${err.message}`);
    return null;
  }
}

function clearOiWallFadePosition() {
  _persistAtomic(OIWF_POS_FILE, null);
  console.log("[PERSIST] OI_WALL_FADE position file cleared.");
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

module.exports = {
  saveTradePosition, loadTradePosition, clearTradePosition,
  saveBbRsiPosition, loadBbRsiPosition, clearBbRsiPosition,
  savePAPosition, loadPAPosition, clearPAPosition,
  saveEma9VwapPosition, loadEma9VwapPosition, clearEma9VwapPosition,
  saveOrbPosition, loadOrbPosition, clearOrbPosition,
  saveTrendPbPosition, loadTrendPbPosition, clearTrendPbPosition,
  saveGapsPosition, loadGapsPosition, clearGapsPosition,
  saveTrendDayScalpPosition, loadTrendDayScalpPosition, clearTrendDayScalpPosition,
  saveGapFix3mPosition, loadGapFix3mPosition, clearGapFix3mPosition,
  saveOiWallFadePosition, loadOiWallFadePosition, clearOiWallFadePosition,
  saveRsiPivotStPosition, loadRsiPivotStPosition, clearRsiPivotStPosition,
};

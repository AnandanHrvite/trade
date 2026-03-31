/**
 * SCALP PAPER TRADE — /scalp-paper
 * ─────────────────────────────────────────────────────────────────────────────
 * Uses LIVE market data (Fyers WebSocket) but SIMULATES orders locally.
 * Runs on 3-min candles with the scalp EMA9+RSI strategy.
 * Can run IN PARALLEL with /trade (live) or /paperTrade (paper).
 *
 * Routes:
 *   GET /scalp-paper/start   → Start scalp paper trading
 *   GET /scalp-paper/stop    → Stop session
 *   GET /scalp-paper/status  → Live status page
 *   GET /scalp-paper/exit    → Manual exit current position
 * ─────────────────────────────────────────────────────────────────────────────
 */

const express = require("express");
const router  = express.Router();
const fs      = require("fs");
const path    = require("path");
const scalpStrategy = require("../strategies/scalp_bb_cpr");
const instrumentConfig = require("../config/instrument");
const { getSymbol, getLotQty, validateAndGetOptionSymbol } = instrumentConfig;
const sharedSocketState = require("../utils/sharedSocketState");
const socketManager = require("../utils/socketManager");
const { buildSidebar, sidebarCSS, modalCSS, modalJS } = require("../utils/sharedNav");
const { isTradingAllowed } = require("../utils/nseHolidays");
const vixFilter = require("../services/vixFilter");
const { checkLiveVix, fetchLiveVix, getCachedVix, resetCache: resetVixCache } = vixFilter;
const fyers = require("../config/fyers");
const { notifyEntry, notifyExit, sendTelegram, isConfigured } = require("../utils/notify");

const NIFTY_INDEX_SYMBOL = "NSE:NIFTY50-INDEX";
const CALLBACK_ID = "SCALP_PAPER";

// ── Module-level config (read once at module load) ────────────────────────────
const SCALP_RES            = parseInt(process.env.SCALP_RESOLUTION || "3", 10);
const _SCALP_MAX_TRADES    = parseInt(process.env.SCALP_MAX_DAILY_TRADES || "30", 10);
const _SCALP_MAX_LOSS      = parseFloat(process.env.SCALP_MAX_DAILY_LOSS || "2000");
const _SCALP_PAUSE_CANDLES = parseInt(process.env.SCALP_SL_PAUSE_CANDLES || "2", 10);
const _SCALP_MAX_SL        = parseFloat(process.env.SCALP_MAX_SL || "300");
const _SCALP_TRAIL_START   = parseFloat(process.env.SCALP_TRAIL_START || "300");
const _SCALP_TRAIL_STEP    = parseFloat(process.env.SCALP_TRAIL_STEP || "200");
const _SCALP_BE_TRIGGER    = parseFloat(process.env.SCALP_BE_TRIGGER || "0");

// ── Previous day OHLC for CPR (fetched on session start) ────────────────────
let _prevDayOHLC     = null;  // { high, low, close }
let _prevPrevDayOHLC = null;  // for Inside Value CPR check

const _STOP_MINS = (() => {
  const raw = process.env.TRADE_STOP_TIME || "15:30";
  const [h, m] = raw.split(":").map(Number);
  return h * 60 + (isNaN(m) ? 0 : m);
})();
const _ENTRY_STOP_MINS = _STOP_MINS - 10;

function getISTMinutes() {
  const istSec = Math.floor(Date.now() / 1000) + 19800;
  return Math.floor(istSec / 60) % 1440;
}

// ── Persistence ──────────────────────────────────────────────────────────────
const _HOME    = require("os").homedir();
const DATA_DIR = path.join(_HOME, "trading-data");
const SP_FILE  = path.join(DATA_DIR, "scalp_paper_trades.json");

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadScalpData() {
  ensureDir();
  if (!fs.existsSync(SP_FILE)) {
    const initial = { capital: 100000, totalPnl: 0, sessions: [] };
    fs.writeFileSync(SP_FILE, JSON.stringify(initial, null, 2));
    return initial;
  }
  try { return JSON.parse(fs.readFileSync(SP_FILE, "utf-8")); }
  catch (_) { return { capital: 100000, totalPnl: 0, sessions: [] }; }
}

function saveScalpData(data) {
  ensureDir();
  const tmp = SP_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, SP_FILE);
}

// ── State ────────────────────────────────────────────────────────────────────
let state = {
  running:        false,
  position:       null,
  candles:        [],
  currentBar:     null,
  barStartTime:   null,
  log:            [],
  sessionTrades:  [],
  sessionStart:   null,
  sessionPnl:     0,
  tickCount:      0,
  lastTickTime:   null,
  lastTickPrice:  null,
  optionLtp:      null,
  optionSymbol:   null,
  _slPauseUntil:  null,
  _dailyLossHit:  false,
};

function istNow() {
  return new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
}

function log(msg) {
  const entry = `[${istNow()}] ${msg}`;
  console.log(entry);
  state.log.push(entry);
  if (state.log.length > 2000) state.log.shift();
}

function getBucketStart(unixMs) {
  const d = new Date(unixMs);
  d.setMinutes(Math.floor(d.getMinutes() / SCALP_RES) * SCALP_RES, 0, 0);
  return d.getTime();
}

function isMarketHours() {
  const total = getISTMinutes();
  return total >= 555 && total < _ENTRY_STOP_MINS; // 9:15 to stop-10min
}

function isStartAllowed() {
  return getISTMinutes() < _STOP_MINS;
}

// ── Option LTP polling ──────────────────────────────────────────────────────
let _optionPollTimer = null;

async function fetchOptionLtp(symbol) {
  try {
    const response = await fyers.getQuotes([symbol]);
    if (response.s === "ok" && response.d && response.d.length > 0) {
      const v = response.d[0].v || response.d[0];
      const ltp = v.lp || v.ltp || v.last_price || v.last_traded_price || v.close_price;
      if (ltp && ltp > 0) return parseFloat(ltp);
    }
  } catch (_) {}
  return null;
}

function startOptionPolling(symbol) {
  stopOptionPolling();
  function scheduleNext() {
    if (!_optionPollTimer) return;
    _optionPollTimer = setTimeout(async () => {
      if (!state.position || !state.optionSymbol) { stopOptionPolling(); return; }
      const ltp = await fetchOptionLtp(symbol);
      if (ltp && state.position) {
        state.optionLtp = ltp;
        state.position.optionCurrentLtp = ltp;
        if (!state.position.optionEntryLtp) {
          state.position.optionEntryLtp = ltp;
          log(`📌 [SCALP-PAPER] Option entry LTP: ₹${ltp}`);
        }
      }
      scheduleNext();
    }, 3000); // 3s for scalp paper (less aggressive than live)
  }
  fetchOptionLtp(symbol).then(ltp => {
    if (ltp && state.position) {
      state.optionLtp = ltp;
      state.position.optionCurrentLtp = ltp;
      if (!state.position.optionEntryLtp) state.position.optionEntryLtp = ltp;
    }
    scheduleNext();
  });
  _optionPollTimer = true;
}

function stopOptionPolling() {
  if (_optionPollTimer && _optionPollTimer !== true) clearTimeout(_optionPollTimer);
  _optionPollTimer = null;
}

// ── Simulated Buy/Sell ──────────────────────────────────────────────────────

function simulateBuy(symbol, side, qty, price, reason, stopLoss, target, spotAtEntry) {
  if (state.position) return;

  state.position = {
    side,
    symbol,
    qty,
    entryPrice:       price,
    spotAtEntry:      spotAtEntry || price,
    entryTime:        istNow(),
    reason,
    stopLoss,
    initialStopLoss:  stopLoss,
    target,
    bestPrice:        null,
    candlesHeld:      0,
    peakPnl:          0,
    beTriggered:      false,
    entryBarTime:     state.currentBar ? state.currentBar.time : null,
    optionEntryLtp:   null,
    optionCurrentLtp: null,
  };

  state.optionSymbol = symbol;
  if (instrumentConfig.INSTRUMENT !== "NIFTY_FUTURES") {
    startOptionPolling(symbol);
  }

  log(`📝 [SCALP-PAPER] BUY ${qty} × ${symbol} @ ₹${price} | SL: ₹${stopLoss} | PSAR trail | ${reason}`);

  notifyEntry({
    mode: "SCALP-PAPER",
    side, symbol, spotAtEntry: price,
    stopLoss, qty, reason,
  });
}

function simulateSell(exitPrice, reason, spotAtExit) {
  if (!state.position) return;

  const { side, symbol, qty, entryPrice, entryTime, spotAtEntry,
          optionEntryLtp, optionCurrentLtp } = state.position;
  const isFutures = instrumentConfig.INSTRUMENT === "NIFTY_FUTURES";
  const exitOptionLtp = state.optionLtp || optionCurrentLtp;

  let rawPnl, pnlMode;
  if (isFutures) {
    rawPnl  = (exitPrice - entryPrice) * (side === "CE" ? 1 : -1) * qty;
    pnlMode = "futures";
  } else if (optionEntryLtp && exitOptionLtp) {
    rawPnl  = (exitOptionLtp - optionEntryLtp) * qty;
    pnlMode = `option: ₹${optionEntryLtp} → ₹${exitOptionLtp}`;
  } else {
    rawPnl  = (exitPrice - entryPrice) * (side === "CE" ? 1 : -1) * qty;
    pnlMode = "spot proxy";
  }

  const brokerage = isFutures ? 40 : 80;
  const netPnl    = parseFloat((rawPnl - brokerage).toFixed(2));
  const emoji     = netPnl >= 0 ? "✅" : "❌";

  log(`${emoji} [SCALP-PAPER] Exit: ${reason} | PnL: ₹${netPnl}`);

  state.sessionTrades.push({
    side, symbol, qty, entryPrice, exitPrice,
    spotAtEntry: spotAtEntry || entryPrice,
    spotAtExit: spotAtExit || exitPrice,
    optionEntryLtp: optionEntryLtp || null,
    optionExitLtp: exitOptionLtp || null,
    entryTime, exitTime: istNow(),
    pnl: netPnl, pnlMode, exitReason: reason,
  });

  state.sessionPnl = parseFloat((state.sessionPnl + netPnl).toFixed(2));

  stopOptionPolling();
  state.optionSymbol = null;
  state.optionLtp    = null;

  // SL pause
  if (reason.includes("SL hit")) {
    state._slPauseUntil = Date.now() + (_SCALP_PAUSE_CANDLES * SCALP_RES * 60 * 1000);
    log(`⏸️ [SCALP-PAPER] SL pause — no entries for ${_SCALP_PAUSE_CANDLES} candles`);
  }

  // Daily loss kill
  if (state.sessionPnl <= -_SCALP_MAX_LOSS) {
    state._dailyLossHit = true;
    log(`🚨 [SCALP-PAPER] Daily loss limit hit (₹${state.sessionPnl} <= -₹${_SCALP_MAX_LOSS}) — no more entries today`);
  }

  state.position = null;

  notifyExit({
    mode: "SCALP-PAPER",
    side, symbol, spotAtExit: exitPrice,
    optionExitLtp: exitOptionLtp, pnl: netPnl, reason,
  });
}

// ── onTick — processes each WebSocket tick ───────────────────────────────────

function onTick(tick) {
  if (!state.running) return;
  const price = tick.ltp;
  if (!price || price <= 0) return;

  state.tickCount++;
  state.lastTickTime  = Date.now();
  state.lastTickPrice = price;

  // ── Build 3-min candle ─────────────────────────────────────────────────────
  const tickMs    = Date.now();
  const bucketMs  = getBucketStart(tickMs);

  if (!state.currentBar || state.barStartTime !== bucketMs) {
    // Close previous bar
    if (state.currentBar) {
      state.candles.push({ ...state.currentBar });
      if (state.candles.length > 200) state.candles.shift();
      onCandleClose(state.currentBar);
    }
    // Start new bar
    state.currentBar  = { time: Math.floor(bucketMs / 1000), open: price, high: price, low: price, close: price };
    state.barStartTime = bucketMs;
  } else {
    state.currentBar.high  = Math.max(state.currentBar.high, price);
    state.currentBar.low   = Math.min(state.currentBar.low, price);
    state.currentBar.close = price;
  }

  // ── Tick-level exit checks (while in position) ─────────────────────────────
  if (state.position) {
    const pos = state.position;
    const isFut = instrumentConfig.INSTRUMENT === "NIFTY_FUTURES";
    const _brok = isFut ? 40 : 80;

    // Running PNL helper (₹)
    const _tickPnl = (spotPrice) => {
      if (!isFut && pos.optionEntryLtp && state.optionLtp) {
        return (state.optionLtp - pos.optionEntryLtp) * (pos.qty || getLotQty()) - _brok;
      }
      return (spotPrice - pos.entryPrice) * (pos.side === "CE" ? 1 : -1) * (pos.qty || getLotQty()) - _brok;
    };

    const curPnl = _tickPnl(price);

    // Track peak PNL
    if (!pos.peakPnl || curPnl > pos.peakPnl) pos.peakPnl = curPnl;

    // Breakeven SL: once PNL crosses trigger, move SL to entry
    if (_SCALP_BE_TRIGGER > 0 && !pos.beTriggered && pos.peakPnl >= _SCALP_BE_TRIGGER) {
      pos.beTriggered = true;
      pos.stopLoss = pos.entryPrice;
      log(`🔒 [SCALP-PAPER] Breakeven SL activated at ₹${pos.entryPrice}`);
    }

    // 1. MAX SL (₹300) — absolute hard stop, checked FIRST
    if (_SCALP_MAX_SL > 0 && curPnl <= -_SCALP_MAX_SL) {
      simulateSell(price, `Max SL ₹${_SCALP_MAX_SL}`, price);
      return;
    }

    // 2. TRAILING PROFIT — levels: 300, 500, 700, 900...
    if (_SCALP_TRAIL_START > 0 && pos.peakPnl >= _SCALP_TRAIL_START) {
      const levelsAbove = Math.floor((pos.peakPnl - _SCALP_TRAIL_START) / _SCALP_TRAIL_STEP);
      const highestLevel = _SCALP_TRAIL_START + (levelsAbove * _SCALP_TRAIL_STEP);
      const trailFloor = Math.max(0, highestLevel - _SCALP_TRAIL_STEP);
      if (curPnl <= trailFloor) {
        simulateSell(price, `Trail profit ₹${trailFloor} (peak ₹${Math.round(pos.peakPnl)})`, price);
        return;
      }
    }

    // 3. PSAR SL hit (tick-level) — capped at max SL
    if (pos.side === "CE" && price <= pos.stopLoss) {
      const slPnl = _tickPnl(pos.stopLoss);
      if (_SCALP_MAX_SL <= 0 || slPnl >= -_SCALP_MAX_SL) {
        const _isTrail = pos.initialStopLoss != null && Math.abs(pos.stopLoss - pos.initialStopLoss) > 0.5;
        simulateSell(pos.stopLoss, `${_isTrail ? "PSAR Trail" : "PSAR"} SL hit`, price);
      } else {
        simulateSell(price, `Max SL ₹${_SCALP_MAX_SL}`, price);
      }
      return;
    }
    if (pos.side === "PE" && price >= pos.stopLoss) {
      const slPnl = _tickPnl(pos.stopLoss);
      if (_SCALP_MAX_SL <= 0 || slPnl >= -_SCALP_MAX_SL) {
        const _isTrail = pos.initialStopLoss != null && Math.abs(pos.stopLoss - pos.initialStopLoss) > 0.5;
        simulateSell(pos.stopLoss, `${_isTrail ? "PSAR Trail" : "PSAR"} SL hit`, price);
      } else {
        simulateSell(price, `Max SL ₹${_SCALP_MAX_SL}`, price);
      }
      return;
    }

    // EOD check
    const nowMin = getISTMinutes();
    if (nowMin >= _STOP_MINS - 10) {
      simulateSell(price, "EOD square-off", price);
      return;
    }
  }
}

// ── onCandleClose — evaluate signal on 3-min bar close ──────────────────────

function onCandleClose(bar) {
  if (!state.running) return;

  // Count candles held + PSAR-based exit checks
  if (state.position) {
    state.position.candlesHeld = (state.position.candlesHeld || 0) + 1;

    const window = [...state.candles];
    if (state.currentBar) window.push(state.currentBar);

    // PSAR flip → exit on reversal signal
    if (window.length >= 15 && scalpStrategy.isPSARFlip(window, state.position.side)) {
      simulateSell(bar.close, "PSAR flip", bar.close);
      return;
    }

    // Update PSAR trailing SL (tighten only, never below breakeven)
    if (window.length >= 15) {
      const newSL = scalpStrategy.updateTrailingSL(window, state.position.stopLoss, state.position.side);
      if (newSL !== state.position.stopLoss) {
        if (state.position.beTriggered) {
          const isBetter = state.position.side === "CE" ? newSL > state.position.entryPrice : newSL < state.position.entryPrice;
          if (isBetter) {
            log(`📐 [SCALP-PAPER] PSAR trail SL: ₹${state.position.stopLoss} → ₹${newSL}`);
            state.position.stopLoss = newSL;
          }
        } else {
          log(`📐 [SCALP-PAPER] PSAR trail SL: ₹${state.position.stopLoss} → ₹${newSL}`);
          state.position.stopLoss = newSL;
        }
      }
    }

    return; // In position — don't look for new entry
  }

  // ── Entry evaluation ──────────────────────────────────────────────────────
  if (!isMarketHours()) return;
  if (state._dailyLossHit) return;
  if (state.sessionTrades.length >= _SCALP_MAX_TRADES) return;
  if (state._slPauseUntil && Date.now() < state._slPauseUntil) return;
  if (!_prevDayOHLC) return;

  // VIX check
  if (process.env.SCALP_VIX_ENABLED === "true") {
    const vix = getCachedVix();
    if (vix) {
      const vixMax = parseFloat(process.env.VIX_MAX_ENTRY || "20");
      if (vix.value > vixMax) {
        return;
      }
    }
  }

  const window = [...state.candles];
  if (window.length < 30) return;

  const result = scalpStrategy.getSignal(window, {
    silent: false,
    prevDayOHLC: _prevDayOHLC,
    prevPrevDayOHLC: _prevPrevDayOHLC,
  });
  if (result.signal === "NONE") return;

  const side = result.signal === "BUY_CE" ? "CE" : "PE";
  const spot = bar.close;

  // Resolve option symbol
  resolveAndEnter(side, spot, result);
}

async function resolveAndEnter(side, spot, result) {
  try {
    const optionInfo = await validateAndGetOptionSymbol(spot, side);
    if (optionInfo.invalid) {
      log(`⚠️ [SCALP-PAPER] Option symbol invalid for ${side} — skipping entry`);
      return;
    }
    const qty = getLotQty();
    simulateBuy(optionInfo.symbol, side, qty, spot, result.reason, result.stopLoss, result.target, spot);
  } catch (err) {
    log(`⚠️ [SCALP-PAPER] Symbol resolution failed: ${err.message}`);
  }
}

// ── Pre-load history ────────────────────────────────────────────────────────

async function preloadHistory() {
  try {
    const { fetchCandlesCached } = require("../utils/candleCache");
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    const candles = await fetchCandlesCached(
      NIFTY_INDEX_SYMBOL, String(SCALP_RES), today, today,
      `scalp_paper_${SCALP_RES}m`
    );
    if (candles && candles.length > 0) {
      state.candles = candles.slice(-99);
      log(`📦 [SCALP-PAPER] Pre-loaded ${state.candles.length} × ${SCALP_RES}-min candles`);
    }
  } catch (err) {
    log(`⚠️ [SCALP-PAPER] Pre-load failed: ${err.message} — will build from ticks`);
  }

  // Fetch previous day(s) OHLC for CPR calculation
  try {
    const { fetchCandles } = require("../services/backtestEngine");
    // Fetch last 5 days of daily candles to get prev & prev-prev day
    const todayDate = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    const fiveDaysAgo = new Date(Date.now() - 7 * 86400000).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    const dailyCandles = await fetchCandles(NIFTY_INDEX_SYMBOL, "D", fiveDaysAgo, todayDate);
    if (dailyCandles && dailyCandles.length >= 2) {
      // Last complete day (not today)
      const sorted = dailyCandles.sort((a, b) => a.time - b.time);
      // Filter out today's candle
      const pastDays = sorted.filter(c => {
        const d = new Date(c.time * 1000).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
        return d < todayDate;
      });
      if (pastDays.length >= 1) {
        const prev = pastDays[pastDays.length - 1];
        _prevDayOHLC = { high: prev.high, low: prev.low, close: prev.close };
        log(`📊 [SCALP-PAPER] Prev day OHLC: H=${prev.high} L=${prev.low} C=${prev.close}`);
      }
      if (pastDays.length >= 2) {
        const pp = pastDays[pastDays.length - 2];
        _prevPrevDayOHLC = { high: pp.high, low: pp.low, close: pp.close };
      }

      // Log CPR info
      if (_prevDayOHLC) {
        const cpr = scalpStrategy.calcCPR(_prevDayOHLC.high, _prevDayOHLC.low, _prevDayOHLC.close);
        const narrow = scalpStrategy.isNarrowCPR(cpr);
        log(`📊 [SCALP-PAPER] CPR: TC=${cpr.tc} BC=${cpr.bc} Width=${cpr.width} ${narrow ? "✅ NARROW (trending)" : "❌ WIDE (skip entries)"}`);
      }
    } else {
      log(`⚠️ [SCALP-PAPER] Not enough daily candles for CPR — entries blocked until data available`);
    }
  } catch (err) {
    log(`⚠️ [SCALP-PAPER] CPR data fetch failed: ${err.message}`);
  }
}

// ── Auto-stop timer ─────────────────────────────────────────────────────────
let _autoStopTimer = null;

function scheduleAutoStop(stopFn) {
  if (_autoStopTimer) { clearTimeout(_autoStopTimer); _autoStopTimer = null; }
  const stopH = Math.floor(_STOP_MINS / 60);
  const stopM = _STOP_MINS % 60;
  const now   = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const stopAt = new Date(now);
  stopAt.setHours(stopH, stopM, 0, 0);
  const ms = stopAt - now;
  if (ms <= 0) return;
  _autoStopTimer = setTimeout(() => {
    if (!state.running) return;
    stopFn("⏰ [SCALP-PAPER] Auto-stop: " + stopH + ":" + String(stopM).padStart(2, "0") + " reached");
  }, ms);
  log(`⏰ [SCALP-PAPER] Auto-stop in ${Math.round(ms / 60000)} min`);
}

// ── Styled error page ─────────────────────────────────────────────────────────
function errorPage(title, message, linkHref, linkText) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${title}</title>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;600;700&family=IBM+Plex+Mono:wght@500;700&display=swap" rel="stylesheet">
<style>
${sidebarCSS()}
*{box-sizing:border-box;margin:0;padding:0;}body{font-family:'IBM Plex Sans',sans-serif;background:#060810;color:#a0b8d8;min-height:100vh;display:flex;flex-direction:column;}
.main-content{flex:1;padding:40px 32px;margin-left:220px;display:flex;align-items:center;justify-content:center;}
@media(max-width:900px){.main-content{margin-left:0;}}
.err-box{background:#0d1320;border:1px solid #7f1d1d;border-radius:14px;padding:40px 48px;max-width:480px;text-align:center;}
.err-icon{font-size:2.5rem;margin-bottom:16px;}
.err-title{color:#ef4444;margin-bottom:12px;font-size:1.1rem;font-weight:700;}
.err-msg{font-size:0.85rem;color:#8899aa;margin-bottom:24px;line-height:1.6;}
.err-link{background:#1e40af;color:#fff;padding:9px 22px;border-radius:8px;text-decoration:none;font-weight:600;font-size:0.85rem;display:inline-block;}
.err-link:hover{background:#2563eb;}
</style></head><body>
<div class="app-shell">
${buildSidebar('scalpPaper', false)}
<div class="main-content">
<div class="err-box">
<div class="err-icon">🚫</div>
<h2 class="err-title">${title}</h2>
<p class="err-msg">${message}</p>
${linkHref ? `<a href="${linkHref}" class="err-link">${linkText || 'Go Back'}</a>` : ''}
</div></div></div></body></html>`;
}

// ── Routes ────────────────────────────────────────────────────────────────────

router.get("/start", async (req, res) => {
  if (state.running) return res.redirect("/scalp-paper/status");

  const check = sharedSocketState.canStart("SCALP_PAPER");
  if (!check.allowed) {
    return res.status(409).send(errorPage("Cannot Start", check.reason, "/scalp-paper/status", "\u2190 Back"));
  }

  if (!process.env.ACCESS_TOKEN) {
    return res.status(401).send(errorPage("Not Authenticated", "Fyers not logged in. Login first.", "/auth", "Login with Fyers"));
  }

  const holiday = await isTradingAllowed();
  if (!holiday.allowed) {
    return res.status(400).send(errorPage("Trading Not Allowed", holiday.reason, "/scalp-paper/status", "\u2190 Back"));
  }

  if (!isStartAllowed()) {
    return res.status(400).send(errorPage("Session Closed", "Past stop time \u2014 cannot start today.", "/scalp-paper/status", "\u2190 Back"));
  }

  // Reset state
  state = {
    running: true, position: null, candles: [], currentBar: null, barStartTime: null,
    log: [], sessionTrades: [], sessionStart: new Date().toISOString(),
    sessionPnl: 0, tickCount: 0, lastTickTime: null, lastTickPrice: null,
    optionLtp: null, optionSymbol: null, _slPauseUntil: null, _dailyLossHit: false,
  };

  sharedSocketState.setScalpActive("SCALP_PAPER");

  // Pre-load history
  await preloadHistory();

  // Start VIX polling
  if (process.env.SCALP_VIX_ENABLED === "true") {
    resetVixCache();
    fetchLiveVix().catch(() => {});
  }

  // Socket: piggyback if already running, else start our own
  if (socketManager.isRunning()) {
    socketManager.addCallback(CALLBACK_ID, onTick, log);
    log("📡 [SCALP-PAPER] Piggybacking on existing WebSocket");
  } else {
    socketManager.start(NIFTY_INDEX_SYMBOL, () => {}, log); // dummy primary callback
    socketManager.addCallback(CALLBACK_ID, onTick, log);
    log("📡 [SCALP-PAPER] Started WebSocket (own instance)");
  }

  // Auto-stop
  scheduleAutoStop((msg) => {
    log(msg);
    stopSession();
  });

  log(`🟢 [SCALP-PAPER] Session started — ${SCALP_RES}-min candles`);
  res.redirect("/scalp-paper/status");
});

function stopSession() {
  if (!state.running) return;

  // Exit any open position
  if (state.position) {
    simulateSell(state.lastTickPrice || state.position.entryPrice, "Session stopped", state.lastTickPrice);
  }

  state.running = false;
  stopOptionPolling();
  socketManager.removeCallback(CALLBACK_ID);

  // If we were the only socket user and no primary mode is active, stop socket
  if (!sharedSocketState.isActive() && socketManager.isRunning()) {
    // Don't stop — primary mode might still need it
    // Only stop if no primary mode AND no other scalp mode
    if (!sharedSocketState.isScalpActive() || sharedSocketState.getScalpMode() === "SCALP_PAPER") {
      // Check if primary mode needs it
      if (!sharedSocketState.isActive()) {
        socketManager.stop();
      }
    }
  }

  sharedSocketState.clearScalp();

  if (_autoStopTimer) { clearTimeout(_autoStopTimer); _autoStopTimer = null; }

  // Save session
  if (state.sessionTrades.length > 0) {
    try {
      const data = loadScalpData();
      data.sessions.push({
        date:     state.sessionStart,
        strategy: scalpStrategy.NAME,
        pnl:      state.sessionPnl,
        trades:   state.sessionTrades,
      });
      data.totalPnl = parseFloat((data.totalPnl + state.sessionPnl).toFixed(2));
      saveScalpData(data);
      log(`💾 [SCALP-PAPER] Session saved — ${state.sessionTrades.length} trades, PnL: ₹${state.sessionPnl}`);
    } catch (err) {
      log(`⚠️ [SCALP-PAPER] Save failed: ${err.message}`);
    }
  }

  log("🔴 [SCALP-PAPER] Session stopped");
}

router.get("/stop", (req, res) => {
  stopSession();
  res.redirect("/scalp-paper/status");
});

router.get("/exit", (req, res) => {
  if (state.position) {
    simulateSell(state.lastTickPrice || state.position.entryPrice, "Manual exit", state.lastTickPrice);
  }
  res.redirect("/scalp-paper/status");
});

// ── Status data (AJAX poll) ─────────────────────────────────────────────────

router.get("/status/data", (req, res) => {
  const pos = state.position;
  const unrealised = pos
    ? parseFloat(((state.lastTickPrice - pos.entryPrice) * (pos.side === "CE" ? 1 : -1) * (pos.qty || getLotQty())).toFixed(2))
    : 0;

  res.json({
    running:       state.running,
    tickCount:     state.tickCount,
    lastTickPrice: state.lastTickPrice,
    lastTickTime:  state.lastTickTime ? new Date(state.lastTickTime).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" }) : null,
    candleCount:   state.candles.length,
    currentBar:    state.currentBar,
    position:      pos ? {
      side:          pos.side,
      symbol:        pos.symbol,
      entryPrice:    pos.entryPrice,
      stopLoss:      pos.stopLoss,
      target:        pos.target,
      bestPrice:     pos.bestPrice,
      candlesHeld:   pos.candlesHeld,
      optionEntryLtp: pos.optionEntryLtp,
      optionCurrentLtp: pos.optionCurrentLtp,
    } : null,
    sessionPnl:    state.sessionPnl,
    unrealised,
    totalPnl:      parseFloat((state.sessionPnl + unrealised).toFixed(2)),
    trades:        state.sessionTrades.length,
    wins:          state.sessionTrades.filter(t => t.pnl > 0).length,
    losses:        state.sessionTrades.filter(t => t.pnl <= 0).length,
    log:           state.log.slice(-50),
    dailyLossHit:  state._dailyLossHit,
    sessionTrades: state.sessionTrades.map(t => ({
      side:           t.side,
      symbol:         t.symbol,
      entryTime:      t.entryTime,
      exitTime:       t.exitTime,
      entryPrice:     t.entryPrice,
      exitPrice:      t.exitPrice,
      spotAtEntry:    t.spotAtEntry,
      spotAtExit:     t.spotAtExit,
      optionEntryLtp: t.optionEntryLtp,
      optionExitLtp:  t.optionExitLtp,
      pnl:            t.pnl,
      exitReason:     t.exitReason,
    })),
    optionLtp:     state.optionLtp,
  });
});

// ── Status page ─────────────────────────────────────────────────────────────

router.get("/status", (req, res) => {
  const liveActive  = sharedSocketState.getMode() === "LIVE_TRADE";
  const pos         = state.position;

  // Unrealised PnL
  let unrealisedPnl = 0;
  if (pos && state.lastTickPrice) {
    const optEntry = pos.optionEntryLtp;
    const optCurr  = state.optionLtp || pos.optionCurrentLtp;
    if (optEntry && optCurr && optEntry > 0) {
      unrealisedPnl = parseFloat(((optCurr - optEntry) * (pos.qty || getLotQty())).toFixed(2));
    } else {
      unrealisedPnl = parseFloat(((state.lastTickPrice - pos.entryPrice) * (pos.side === "CE" ? 1 : -1) * (pos.qty || getLotQty())).toFixed(2));
    }
  }

  const inr = (n) => typeof n === "number"
    ? n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : "\u2014";
  const pnlColor = (n) => n >= 0 ? "#10b981" : "#ef4444";

  const wins   = state.sessionTrades.filter(t => t.pnl > 0).length;
  const losses = state.sessionTrades.filter(t => t.pnl <= 0).length;

  // Trades table rows (server-rendered initial state)
  const tradesRows = state.sessionTrades.map((t, i) => {
    const pc = t.pnl >= 0 ? "#10b981" : "#ef4444";
    const symShort = t.symbol ? t.symbol.split(":").pop() : "\u2014";
    return `<tr>
      <td style="padding:8px 10px;border-bottom:1px solid #1a2236;color:${t.side === "CE" ? "#10b981" : "#ef4444"};font-weight:700;">${t.side}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #1a2236;font-size:0.72rem;color:#c8d8f0;font-family:'IBM Plex Mono',monospace;">${symShort}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #1a2236;font-size:0.72rem;color:#8899aa;">${t.entryTime || "\u2014"}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #1a2236;font-size:0.72rem;color:#8899aa;">${t.exitTime || "\u2014"}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #1a2236;font-family:'IBM Plex Mono',monospace;font-size:0.78rem;color:#c8d8f0;">${inr(t.spotAtEntry)}${t.optionEntryLtp ? '<br><span style="font-size:0.65rem;color:#60a5fa;">Opt: \u20b9' + t.optionEntryLtp.toFixed(2) + '</span>' : ''}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #1a2236;font-family:'IBM Plex Mono',monospace;font-size:0.78rem;color:#c8d8f0;">${inr(t.spotAtExit)}${t.optionExitLtp ? '<br><span style="font-size:0.65rem;color:#60a5fa;">Opt: \u20b9' + t.optionExitLtp.toFixed(2) + '</span>' : ''}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #1a2236;font-family:'IBM Plex Mono',monospace;font-weight:700;color:${pc};">${t.pnl >= 0 ? "+" : ""}\u20b9${inr(t.pnl)}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #1a2236;font-size:0.7rem;color:#8899aa;">${t.exitReason || "\u2014"}</td>
    </tr>`;
  }).join("");

  // Position card HTML
  const posHtml = pos ? `
    <div id="pos-card" style="background:#0a1f0a;border:1px solid #065f46;border-radius:12px;padding:20px 24px;margin-bottom:18px;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;flex-wrap:wrap;gap:10px;">
        <div style="display:flex;align-items:center;gap:10px;">
          <span style="width:10px;height:10px;border-radius:50%;background:#10b981;display:inline-block;animation:pulse 1.5s infinite;"></span>
          <span style="font-size:0.8rem;font-weight:700;color:#10b981;text-transform:uppercase;letter-spacing:1px;">Open Position</span>
          <span style="font-size:0.72rem;color:#4a6080;">Since ${pos.entryTime}</span>
        </div>
        <button onclick="spHandleExit(this)"
           style="display:inline-flex;align-items:center;gap:7px;background:#7f1d1d;border:1px solid #ef4444;color:#fca5a5;font-size:0.8rem;font-weight:700;padding:9px 18px;border-radius:8px;cursor:pointer;font-family:inherit;transition:background 0.15s;"
           onmouseover="this.style.background='#991b1b'" onmouseout="this.style.background='#7f1d1d'">
          Exit Trade Now
        </button>
      </div>

      <!-- Side + Entry details grid -->
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;">
        <div style="background:#071a12;border:1px solid #134e35;border-radius:8px;padding:12px 14px;text-align:center;">
          <div style="font-size:0.6rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Side</div>
          <div style="font-size:2rem;font-weight:900;color:${pos.side === "CE" ? "#10b981" : "#ef4444"};">${pos.side}</div>
          <div style="font-size:0.65rem;color:${pos.side === "CE" ? "#10b981" : "#ef4444"};">${pos.side === "CE" ? "CALL" : "PUT"}</div>
        </div>
        <div style="background:#071a12;border:1px solid #134e35;border-radius:8px;padding:12px 14px;">
          <div style="font-size:0.6rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Entry (Spot)</div>
          <div style="font-size:1.1rem;font-weight:700;color:#c8d8f0;font-family:'IBM Plex Mono',monospace;">\u20b9${inr(pos.entryPrice)}</div>
        </div>
        <div style="background:#1c1400;border:1px solid #78350f;border-radius:8px;padding:12px 14px;">
          <div style="font-size:0.6rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Stop Loss</div>
          <div id="ajax-pos-sl" style="font-size:1.1rem;font-weight:700;color:#f59e0b;font-family:'IBM Plex Mono',monospace;">\u20b9${inr(pos.stopLoss)}</div>
        </div>
        <div style="background:#071a12;border:1px solid #134e35;border-radius:8px;padding:12px 14px;">
          <div style="font-size:0.6rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Target</div>
          <div style="font-size:1.1rem;font-weight:700;color:#10b981;font-family:'IBM Plex Mono',monospace;">\u20b9${inr(pos.target)}</div>
        </div>
        <div style="background:#071a12;border:1px solid #134e35;border-radius:8px;padding:12px 14px;">
          <div style="font-size:0.6rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Best Price</div>
          <div id="ajax-pos-best" style="font-size:1.1rem;font-weight:700;color:#8b5cf6;font-family:'IBM Plex Mono',monospace;">${pos.bestPrice ? "\u20b9" + inr(pos.bestPrice) : "\u2014"}</div>
        </div>
        <div style="background:#071a12;border:1px solid #134e35;border-radius:8px;padding:12px 14px;">
          <div style="font-size:0.6rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Candles Held</div>
          <div id="ajax-pos-candles" style="font-size:1.1rem;font-weight:700;color:#c8d8f0;">${pos.candlesHeld || 0} <span style="font-size:0.65rem;color:#4a6080;">/ ${_SCALP_TIME_STOP}</span></div>
        </div>
        <div style="background:#0a0f24;border:1px solid #1e3a5f;border-radius:8px;padding:12px 14px;">
          <div style="font-size:0.6rem;color:#60a5fa;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Option LTP</div>
          <div id="ajax-pos-opt-ltp" style="font-size:1.1rem;font-weight:700;color:#60a5fa;font-family:'IBM Plex Mono',monospace;">${state.optionLtp ? "\u20b9" + state.optionLtp.toFixed(2) : "\u2014"}</div>
        </div>
        <div style="background:${unrealisedPnl >= 0 ? "#071a0f" : "#1a0707"};border:1px solid ${unrealisedPnl >= 0 ? "#065f46" : "#7f1d1d"};border-radius:8px;padding:12px 14px;">
          <div style="font-size:0.6rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Unrealised P&L</div>
          <div id="ajax-pos-pnl" style="font-size:1.1rem;font-weight:700;color:${pnlColor(unrealisedPnl)};font-family:'IBM Plex Mono',monospace;">${unrealisedPnl >= 0 ? "+" : ""}\u20b9${inr(unrealisedPnl)}</div>
        </div>
      </div>
      ${pos.reason ? `<div style="padding:10px 14px;background:#071a12;border-radius:8px;font-size:0.73rem;color:#a7f3d0;line-height:1.5;margin-top:12px;">Entry: ${pos.reason}</div>` : ""}
    </div>` : `
    <div id="pos-card" style="background:#0d1320;border:1px solid #1a2236;border-radius:12px;padding:20px 24px;text-align:center;margin-bottom:18px;">
      <div style="font-size:1.2rem;margin-bottom:6px;color:#4a6080;">FLAT</div>
      <div style="font-size:0.82rem;color:#4a6080;">Waiting for entry signal</div>
    </div>`;

  // Logs JSON for initial render
  const logsJSON = JSON.stringify(state.log.slice(-100))
    .replace(/<\/script>/gi, "<\\/script>")
    .replace(/`/g, "\\u0060")
    .replace(/\$/g, "\\u0024");

  res.setHeader("Content-Type", "text/html");
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Scalp Paper \u2014 ${scalpStrategy.NAME}</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>\u26a1</text></svg>">
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;600;700&family=IBM+Plex+Mono:wght@500;700&display=swap" rel="stylesheet">
<style>
${sidebarCSS()}
${modalCSS()}
*{box-sizing:border-box;margin:0;padding:0;}
body{font-family:'IBM Plex Sans',sans-serif;background:#060810;color:#c0d0e8;min-height:100vh;display:flex;flex-direction:column;}
.main-content{flex:1;padding:28px 32px;margin-left:220px;}
@media(max-width:900px){.main-content{margin-left:0;padding:16px;}}

/* Top bar */
.top-bar{display:flex;align-items:center;gap:14px;margin-bottom:20px;flex-wrap:wrap;}
.top-bar h1{font-size:1.15rem;font-weight:700;color:#e0eaf8;margin:0;}
.top-bar .badge{font-size:0.65rem;font-weight:700;padding:4px 10px;border-radius:6px;text-transform:uppercase;letter-spacing:0.8px;}
.badge-running{background:#064e3b;color:#10b981;border:1px solid #10b981;}
.badge-stopped{background:#1c1017;color:#ef4444;border:1px solid #ef4444;}
.top-bar .res-tag{font-size:0.68rem;color:#4a6080;background:#0d1320;border:1px solid #1a2236;padding:3px 10px;border-radius:5px;font-family:'IBM Plex Mono',monospace;}

/* Stats grid */
.sc-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:18px;}
.sc-card{background:#0d1320;border:1px solid #1a2236;border-radius:10px;padding:14px 16px;}
.sc-label{font-size:0.6rem;color:#4a6080;text-transform:uppercase;letter-spacing:0.8px;margin-bottom:5px;}
.sc-val{font-size:1.05rem;font-weight:700;font-family:'IBM Plex Mono',monospace;color:#c8d8f0;}

/* Trades table */
.trades-section{margin-bottom:18px;}
.trades-section h3{font-size:0.82rem;font-weight:700;color:#e0eaf8;margin-bottom:10px;display:flex;align-items:center;gap:8px;}
.trades-wrap{background:#0d1320;border:1px solid #1a2236;border-radius:10px;overflow:hidden;}
.trades-table{width:100%;border-collapse:collapse;font-size:0.78rem;}
.trades-table th{padding:10px 10px;text-align:left;font-size:0.6rem;color:#4a6080;text-transform:uppercase;letter-spacing:0.8px;border-bottom:2px solid #1a2236;background:#0a0e18;}
.trades-table td{vertical-align:top;}
.trades-empty{padding:24px;text-align:center;color:#4a6080;font-size:0.82rem;}

/* Log viewer */
.log-section{margin-bottom:18px;}
.log-section h3{font-size:0.82rem;font-weight:700;color:#e0eaf8;margin-bottom:10px;display:flex;align-items:center;gap:8px;}
.log-box{background:#0a0e18;border:1px solid #1a2236;border-radius:10px;padding:14px;font-family:'IBM Plex Mono',monospace;font-size:0.65rem;color:#6a8aaa;max-height:320px;overflow-y:auto;white-space:pre-wrap;word-break:break-all;line-height:1.7;}

/* Action buttons */
.actions{display:flex;gap:10px;flex-wrap:wrap;}
.act-btn{padding:9px 20px;border-radius:8px;border:none;font-weight:700;font-size:0.8rem;cursor:pointer;font-family:inherit;transition:all 0.15s;display:inline-flex;align-items:center;gap:6px;}
.act-start{background:#1e40af;color:#fff;border:1px solid #3b82f6;}.act-start:hover{background:#2563eb;}
.act-stop{background:#7f1d1d;color:#fca5a5;border:1px solid #ef4444;}.act-stop:hover{background:#991b1b;}
.act-exit{background:#78350f;color:#fbbf24;border:1px solid #f59e0b;}.act-exit:hover{background:#92400e;}

/* Pulse animation */
@keyframes pulse{0%,100%{opacity:1;}50%{opacity:0.4;}}
</style>
</head>
<body>
<div class="app-shell">
${buildSidebar('scalpPaper', liveActive, state.running)}
<div class="main-content">

<!-- Top bar -->
<div class="top-bar">
  <h1>Scalp Paper Trade</h1>
  <span class="res-tag">${SCALP_RES}-min candles</span>
  <span class="res-tag">MaxSL \u20b9${_SCALP_MAX_SL} / Trail \u20b9${_SCALP_TRAIL_START}/\u20b9${_SCALP_TRAIL_STEP}</span>
  <span id="ajax-status-badge" class="badge ${state.running ? "badge-running" : "badge-stopped"}">${state.running ? "Running" : "Stopped"}</span>
</div>

<!-- Action buttons -->
<div class="actions" style="margin-bottom:18px;">
${state.running
  ? `<button class="act-btn act-stop" onclick="location='/scalp-paper/stop'">Stop Session</button>
     <button class="act-btn act-exit" onclick="spHandleExit(this)">Exit Trade</button>`
  : `<button class="act-btn act-start" onclick="location='/scalp-paper/start'">Start Scalp Paper</button>`}
</div>

<!-- Stats grid (6 cards) -->
<div class="sc-grid">
  <div class="sc-card">
    <div class="sc-label">Session P&L</div>
    <div class="sc-val" id="ajax-session-pnl" style="color:${pnlColor(state.sessionPnl)};">\u20b9${inr(state.sessionPnl)}</div>
  </div>
  <div class="sc-card">
    <div class="sc-label">Unrealised P&L</div>
    <div class="sc-val" id="ajax-unrealised" style="color:${pnlColor(unrealisedPnl)};">${unrealisedPnl >= 0 ? "+" : ""}\u20b9${inr(unrealisedPnl)}</div>
  </div>
  <div class="sc-card">
    <div class="sc-label">Trades (W / L)</div>
    <div class="sc-val" id="ajax-trades-wl">${state.sessionTrades.length} <span style="font-size:0.72rem;color:#4a6080;">(${wins}W / ${losses}L)</span></div>
  </div>
  <div class="sc-card">
    <div class="sc-label">Ticks / Candles</div>
    <div class="sc-val" id="ajax-ticks-candles">${state.tickCount} <span style="font-size:0.72rem;color:#4a6080;">/ ${state.candles.length}c</span></div>
  </div>
  <div class="sc-card">
    <div class="sc-label">Daily Loss Limit</div>
    <div class="sc-val" id="ajax-daily-loss" style="color:${state._dailyLossHit ? "#ef4444" : "#10b981"};">${state._dailyLossHit ? "HIT" : "OK"} <span style="font-size:0.65rem;color:#4a6080;">/ -\u20b9${inr(_SCALP_MAX_LOSS)}</span></div>
  </div>
  <div class="sc-card">
    <div class="sc-label">Max Trades</div>
    <div class="sc-val" id="ajax-max-trades" style="color:${state.sessionTrades.length >= _SCALP_MAX_TRADES ? "#ef4444" : "#c8d8f0"};">${state.sessionTrades.length} <span style="font-size:0.65rem;color:#4a6080;">/ ${_SCALP_MAX_TRADES}</span></div>
  </div>
</div>

<!-- Position card -->
${posHtml}

<!-- Session trades table -->
<div class="trades-section">
  <h3>Session Trades</h3>
  <div class="trades-wrap">
    <table class="trades-table">
      <thead>
        <tr>
          <th>Side</th><th>Strike / Expiry</th><th>Entry Time</th><th>Exit Time</th>
          <th>Entry Price</th><th>Exit Price</th><th>P&L</th><th>Exit Reason</th>
        </tr>
      </thead>
      <tbody id="ajax-trades-body">
        ${tradesRows || '<tr><td colspan="8" class="trades-empty">No trades yet</td></tr>'}
      </tbody>
    </table>
  </div>
</div>

<!-- Log viewer -->
<div class="log-section">
  <h3>Activity Log <span style="font-size:0.6rem;color:#4a6080;font-weight:400;">newest at bottom</span></h3>
  <div class="log-box" id="logBox"></div>
</div>

</div><!-- /main-content -->
</div><!-- /app-shell -->

<script>
${modalJS()}

// ── Initial log render ───────────────────────────────────────────────────
(function(){
  var logs = ${logsJSON};
  var box = document.getElementById('logBox');
  box.textContent = logs.join('\\n');
  box.scrollTop = box.scrollHeight;
})();

// ── Manual exit handler ──────────────────────────────────────────────────
function spHandleExit(btn) {
  if (!confirm('Exit current position now?')) return;
  btn.disabled = true;
  btn.textContent = 'Exiting...';
  fetch('/scalp-paper/exit').then(function(){ location.reload(); }).catch(function(){ location.reload(); });
}

// ── INR formatter ────────────────────────────────────────────────────────
function inr(n) {
  if (typeof n !== 'number' || isNaN(n)) return '\\u2014';
  return n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ── AJAX polling every 2s ────────────────────────────────────────────────
function poll() {
  fetch('/scalp-paper/status/data')
    .then(function(r) { return r.json(); })
    .then(function(d) {
      // Status badge
      var badge = document.getElementById('ajax-status-badge');
      if (badge) {
        badge.textContent = d.running ? 'Running' : 'Stopped';
        badge.className = 'badge ' + (d.running ? 'badge-running' : 'badge-stopped');
      }

      // Stats cards
      var spEl = document.getElementById('ajax-session-pnl');
      if (spEl) {
        spEl.style.color = d.sessionPnl >= 0 ? '#10b981' : '#ef4444';
        spEl.textContent = '\\u20b9' + inr(d.sessionPnl);
      }

      var urEl = document.getElementById('ajax-unrealised');
      if (urEl) {
        urEl.style.color = d.unrealised >= 0 ? '#10b981' : '#ef4444';
        urEl.textContent = (d.unrealised >= 0 ? '+' : '') + '\\u20b9' + inr(d.unrealised);
      }

      var twl = document.getElementById('ajax-trades-wl');
      if (twl) twl.innerHTML = d.trades + ' <span style="font-size:0.72rem;color:#4a6080;">(' + d.wins + 'W / ' + d.losses + 'L)</span>';

      var tc = document.getElementById('ajax-ticks-candles');
      if (tc) tc.innerHTML = d.tickCount + ' <span style="font-size:0.72rem;color:#4a6080;">/ ' + d.candleCount + 'c</span>';

      var dl = document.getElementById('ajax-daily-loss');
      if (dl) {
        dl.style.color = d.dailyLossHit ? '#ef4444' : '#10b981';
        dl.innerHTML = (d.dailyLossHit ? 'HIT' : 'OK') + ' <span style="font-size:0.65rem;color:#4a6080;">/ -\\u20b9' + inr(${_SCALP_MAX_LOSS}) + '</span>';
      }

      var mt = document.getElementById('ajax-max-trades');
      if (mt) {
        mt.style.color = d.trades >= ${_SCALP_MAX_TRADES} ? '#ef4444' : '#c8d8f0';
        mt.innerHTML = d.trades + ' <span style="font-size:0.65rem;color:#4a6080;">/ ${_SCALP_MAX_TRADES}</span>';
      }

      // Position card
      var posCard = document.getElementById('pos-card');
      if (posCard) {
        if (d.position) {
          var p = d.position;
          var sideColor = p.side === 'CE' ? '#10b981' : '#ef4444';

          var slEl = document.getElementById('ajax-pos-sl');
          if (slEl) slEl.textContent = '\\u20b9' + inr(p.stopLoss);

          var bestEl = document.getElementById('ajax-pos-best');
          if (bestEl) bestEl.textContent = p.bestPrice ? '\\u20b9' + inr(p.bestPrice) : '\\u2014';

          var candEl = document.getElementById('ajax-pos-candles');
          if (candEl) candEl.innerHTML = (p.candlesHeld || 0) + ' <span style="font-size:0.65rem;color:#4a6080;">/ ${_SCALP_TIME_STOP}</span>';

          var optEl = document.getElementById('ajax-pos-opt-ltp');
          if (optEl) optEl.textContent = d.optionLtp ? '\\u20b9' + d.optionLtp.toFixed(2) : (p.optionCurrentLtp ? '\\u20b9' + p.optionCurrentLtp.toFixed(2) : '\\u2014');

          var ppnl = document.getElementById('ajax-pos-pnl');
          if (ppnl) {
            ppnl.style.color = d.unrealised >= 0 ? '#10b981' : '#ef4444';
            ppnl.textContent = (d.unrealised >= 0 ? '+' : '') + '\\u20b9' + inr(d.unrealised);
          }
        }
      }

      // Trades table
      var tbody = document.getElementById('ajax-trades-body');
      if (tbody && d.sessionTrades) {
        if (d.sessionTrades.length === 0) {
          tbody.innerHTML = '<tr><td colspan="8" class="trades-empty">No trades yet</td></tr>';
        } else {
          var rows = '';
          for (var i = 0; i < d.sessionTrades.length; i++) {
            var t = d.sessionTrades[i];
            var pc = t.pnl >= 0 ? '#10b981' : '#ef4444';
            var sym = t.symbol ? t.symbol.split(':').pop() : '\\u2014';
            rows += '<tr>' +
              '<td style="padding:8px 10px;border-bottom:1px solid #1a2236;color:' + (t.side === 'CE' ? '#10b981' : '#ef4444') + ';font-weight:700;">' + t.side + '</td>' +
              '<td style="padding:8px 10px;border-bottom:1px solid #1a2236;font-size:0.72rem;color:#c8d8f0;font-family:\\'IBM Plex Mono\\',monospace;">' + sym + '</td>' +
              '<td style="padding:8px 10px;border-bottom:1px solid #1a2236;font-size:0.72rem;color:#8899aa;">' + (t.entryTime || '\\u2014') + '</td>' +
              '<td style="padding:8px 10px;border-bottom:1px solid #1a2236;font-size:0.72rem;color:#8899aa;">' + (t.exitTime || '\\u2014') + '</td>' +
              '<td style="padding:8px 10px;border-bottom:1px solid #1a2236;font-family:\\'IBM Plex Mono\\',monospace;font-size:0.78rem;color:#c8d8f0;">\\u20b9' + inr(t.spotAtEntry) + (t.optionEntryLtp ? '<br><span style="font-size:0.65rem;color:#60a5fa;">Opt: \\u20b9' + t.optionEntryLtp.toFixed(2) + '</span>' : '') + '</td>' +
              '<td style="padding:8px 10px;border-bottom:1px solid #1a2236;font-family:\\'IBM Plex Mono\\',monospace;font-size:0.78rem;color:#c8d8f0;">\\u20b9' + inr(t.spotAtExit) + (t.optionExitLtp ? '<br><span style="font-size:0.65rem;color:#60a5fa;">Opt: \\u20b9' + t.optionExitLtp.toFixed(2) + '</span>' : '') + '</td>' +
              '<td style="padding:8px 10px;border-bottom:1px solid #1a2236;font-family:\\'IBM Plex Mono\\',monospace;font-weight:700;color:' + pc + ';">' + (t.pnl >= 0 ? '+' : '') + '\\u20b9' + inr(t.pnl) + '</td>' +
              '<td style="padding:8px 10px;border-bottom:1px solid #1a2236;font-size:0.7rem;color:#8899aa;">' + (t.exitReason || '\\u2014') + '</td>' +
              '</tr>';
          }
          tbody.innerHTML = rows;
        }
      }

      // Log viewer
      var logEl = document.getElementById('logBox');
      if (logEl && d.log) {
        var atBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 40;
        logEl.textContent = d.log.join('\\n');
        if (atBottom) logEl.scrollTop = logEl.scrollHeight;
      }
    })
    .catch(function() {});
}

poll();
setInterval(poll, 2000);
</script>
</body>
</html>`);
});

module.exports = router;

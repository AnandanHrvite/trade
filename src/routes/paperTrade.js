/**
 * PAPER TRADE — /paperTrade
 * ─────────────────────────────────────────────────────────────────────────────
 * Uses LIVE market data (Fyers WebSocket) but SIMULATES orders locally.
 * NO real orders are placed. Everything is tracked in memory + saved to disk.
 *
 * Flow:
 *   /paperTrade/start  → connects to live socket, starts simulating trades
 *   /paperTrade/stop   → stops socket, saves final session summary
 *   /paperTrade/status → live view: position, PnL, capital, log
 *   /paperTrade/history → all past paper trade sessions
 *   /paperTrade/reset  → wipe paper trade history & reset capital
 * ─────────────────────────────────────────────────────────────────────────────
 */

const express = require("express");
const router = express.Router();
const fs = require("fs");
const path = require("path");
const { fyersDataSocket } = require("fyers-api-v3");
const { getActiveStrategy, ACTIVE } = require("../strategies");
const { getSymbol, getLotQty, INSTRUMENT } = require("../config/instrument");
const sharedSocketState = require("../utils/sharedSocketState");

// ── Persistence ──────────────────────────────────────────────────────────────

const DATA_DIR  = path.join(__dirname, "../../data");
const PT_FILE   = path.join(DATA_DIR, "paper_trades.json");

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadPaperData() {
  ensureDir();
  if (!fs.existsSync(PT_FILE)) {
    const initial = {
      capital: parseFloat(process.env.PAPER_TRADE_CAPITAL || "200000"),
      totalPnl: 0,
      sessions: [],
    };
    fs.writeFileSync(PT_FILE, JSON.stringify(initial, null, 2));
    return initial;
  }
  return JSON.parse(fs.readFileSync(PT_FILE, "utf-8"));
}

function savePaperData(data) {
  ensureDir();
  fs.writeFileSync(PT_FILE, JSON.stringify(data, null, 2));
}

// ── State (in-memory for current session) ───────────────────────────────────

let ptState = {
  running:      false,
  socket:       null,
  position:     null,
  candles:      [],
  currentBar:   null,
  barStartTime: null,
  log:          [],
  sessionTrades: [],
  sessionStart:  null,
  sessionPnl:    0,
  tickCount:     0,        // total ticks received from WebSocket
  lastTickTime:  null,     // timestamp of most recent tick
  lastTickPrice:  null,    // LTP of most recent tick
  prevCandleHigh: null,    // previous completed candle high (intra-candle breach exit)
  prevCandleLow:  null,    // previous completed candle low  (intra-candle breach exit)
  pendingEntry:   null,    // signal fired on candle close → enter at first tick (open) of next candle
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function istNow() {
  return new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
}

function log(msg) {
  const entry = `[${istNow()}] ${msg}`;
  console.log(entry);
  ptState.log.push(entry);
  if (ptState.log.length > 300) ptState.log.shift();
}

function get5MinBucket(unixMs) {
  const d = new Date(unixMs);
  d.setMinutes(Math.floor(d.getMinutes() / 5) * 5, 0, 0);
  return d.getTime();
}

function isMarketHours() {
  const ist = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const total = ist.getHours() * 60 + ist.getMinutes();
  return total >= 555 && total < 920; // 9:15 AM → 3:20 PM
}

function getCapitalFromEnv() {
  return parseFloat(process.env.PAPER_TRADE_CAPITAL || "200000");
}

// ── Simulated order (NO real API call) ──────────────────────────────────────

function simulateBuy(symbol, side, qty, price, reason, stopLoss) {
  ptState.position = {
    side,
    symbol,
    qty,
    entryPrice: price,
    entryTime:  istNow(),
    reason,
    stopLoss:   stopLoss || null,
  };
  const slText = stopLoss ? ` | SL: ₹${stopLoss}` : "";
  log(`📝 [PAPER] BUY ${qty} × ${symbol} @ ₹${price}${slText} | Reason: ${reason}`);
}

function simulateSell(exitPrice, reason) {
  if (!ptState.position) return;

  const { side, symbol, qty, entryPrice, entryTime } = ptState.position;

  // For CE: profit when price goes up. For PE: profit when price goes down.
  // We're always buying options so PnL = (exit - entry) * qty
  // (simplified — premium movement proxy using NIFTY index movement)
  const rawPnl   = (exitPrice - entryPrice) * (side === "CE" ? 1 : -1) * qty;
  const brokerage = 40; // ₹20 per side × 2 (flat brokerage per order)
  const netPnl    = parseFloat((rawPnl - brokerage).toFixed(2));

  const trade = {
    side,
    symbol,
    qty,
    entryPrice,
    exitPrice,
    entryTime,
    exitTime:  istNow(),
    pnl:       netPnl,
    exitReason: reason,
    entryReason: ptState.position.reason,
  };

  ptState.sessionTrades.push(trade);
  ptState.sessionPnl = parseFloat((ptState.sessionPnl + netPnl).toFixed(2));

  const emoji = netPnl >= 0 ? "✅" : "❌";
  log(`${emoji} [PAPER] SELL ${qty} × ${symbol} @ ₹${exitPrice} | PnL: ₹${netPnl} | Reason: ${reason}`);
  log(`💼 [PAPER] Session PnL so far: ₹${ptState.sessionPnl}`);

  ptState.position = null;
}

// ── On each completed 5-min candle ──────────────────────────────────────────

async function onCandleClose(candle) {
  ptState.candles.push(candle);
  ptState.prevCandleHigh = candle.high;  // track for intra-candle breach exit
  ptState.prevCandleLow  = candle.low;
  if (ptState.candles.length > 200) ptState.candles.shift();

  const strategy = getActiveStrategy();
  const { signal, reason, stopLoss } = strategy.getSignal(ptState.candles);

  log(`📊 [PAPER] Candle @ ${candle.close} | Signal: ${signal} | ${reason}`);

  // Dynamic SL update — if strategy returns a new SL (SAR-based), update position SL each candle
  if (ptState.position && stopLoss !== null && stopLoss !== undefined) {
    const oldSL = ptState.position.stopLoss;
    ptState.position.stopLoss = stopLoss;
    if (oldSL !== stopLoss) {
      log(`🔄 [PAPER] SL updated: ₹${oldSL} → ₹${stopLoss} (trailing SAR)`);
    }
  }

  // EOD square-off
  const ist = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  if (ist.getHours() * 60 + ist.getMinutes() >= 920) {
    if (ptState.position) {
      simulateSell(candle.close, "EOD square-off 3:20 PM");
    }
    return;
  }

  // Stoploss check on candle CLOSE (wait for candle to close before exiting)
  if (ptState.position && ptState.position.stopLoss !== null) {
    const sl = ptState.position.stopLoss;
    if (ptState.position.side === "CE" && candle.close < sl) {
      simulateSell(candle.close, `Stoploss hit — candle closed @ ₹${candle.close} below SL ₹${sl}`);
      return;
    }
    if (ptState.position.side === "PE" && candle.close > sl) {
      simulateSell(candle.close, `Stoploss hit — candle closed @ ₹${candle.close} above SL ₹${sl}`);
      return;
    }
  }

  // Exit on opposite signal
  if (ptState.position) {
    const opposite = ptState.position.side === "CE" ? "BUY_PE" : "BUY_CE";
    if (signal === opposite) {
      simulateSell(candle.close, "Opposite signal exit");
    }
  }

  // Queue entry for next candle open — don't enter at signal candle close
  // Realistic: signal detected on close → order placed → fills at next candle open (first tick)
  if (!ptState.position && !ptState.pendingEntry && signal !== "NONE") {
    const side = signal === "BUY_CE" ? "CE" : "PE";
    ptState.pendingEntry = { side, reason, stopLoss: stopLoss || null };
    log(`⏳ [PAPER] Entry QUEUED — ${side} signal detected | Will enter at next candle open`);
  }
}

// ── Tick → 5-min candle builder ─────────────────────────────────────────────

function onTick(tick) {
  if (!tick || !tick.ltp) return;

  // ── Track every incoming WebSocket tick ──────────────────────────────────
  // SL is intentionally NOT checked here — only on candle close (as configured)
  ptState.tickCount++;
  ptState.lastTickTime  = istNow();
  ptState.lastTickPrice = tick.ltp;

  const now    = Date.now();
  const bucket = get5MinBucket(now);

  if (!ptState.currentBar || ptState.barStartTime !== bucket) {
    if (ptState.currentBar) {
      onCandleClose(ptState.currentBar).catch(console.error);
    }
    ptState.currentBar = {
      time:   Math.floor(bucket / 1000),
      open:   tick.ltp,
      high:   tick.ltp,
      low:    tick.ltp,
      close:  tick.ltp,
      volume: tick.vol_traded_today || 0,
    };
    ptState.barStartTime = bucket;

    // ── Execute pending entry at first tick of new candle (= candle open) ──
    // Signal was queued on previous candle close → this tick IS the open price
    if (ptState.pendingEntry && !ptState.position) {
      const pe = ptState.pendingEntry;
      ptState.pendingEntry = null;
      getSymbol(pe.side).then(symbol => {
        const qty = getLotQty();
        log(`🚀 [PAPER] Executing queued entry — ${pe.side} @ ₹${tick.ltp} (next candle open)`);
        simulateBuy(symbol, pe.side, qty, tick.ltp, pe.reason, pe.stopLoss);
      }).catch(err => {
        log(`❌ [PAPER] Failed to execute queued entry: ${err.message}`);
        ptState.pendingEntry = null;
      });
    }

  } else {
    const bar  = ptState.currentBar;
    bar.high   = Math.max(bar.high, tick.ltp);
    bar.low    = Math.min(bar.low,  tick.ltp);
    bar.close  = tick.ltp;
    bar.volume = tick.vol_traded_today || bar.volume;
  }

  // Intra-candle breach exit (STRATEGY_5 exit rule)
  // PE: exit immediately if current candle high breaks above previous candle high
  // CE: exit immediately if current candle low  breaks below previous candle low
  if (ptState.position && ptState.currentBar && ptState.prevCandleHigh !== null) {
    const pos = ptState.position;
    const ltp = tick.ltp;
    if (pos.side === "PE" && ptState.currentBar.high > ptState.prevCandleHigh) {
      log("Intra-candle breach EXIT - PE: bar.high " + ptState.currentBar.high + " > prevHigh " + ptState.prevCandleHigh + " @ tick " + ltp);
      simulateSell(ltp, "Intra-candle breach - current high > prev candle high");
    } else if (pos.side === "CE" && ptState.currentBar.low < ptState.prevCandleLow) {
      log("Intra-candle breach EXIT - CE: bar.low " + ptState.currentBar.low + " < prevLow " + ptState.prevCandleLow + " @ tick " + ltp);
      simulateSell(ltp, "Intra-candle breach - current low < prev candle low");
    }
  }
}

// -- Save completed session to disk ───────────────────────────────────────────

function saveSession() {
  const data = loadPaperData();

  const wins   = ptState.sessionTrades.filter(t => t.pnl > 0);
  const losses = ptState.sessionTrades.filter(t => t.pnl <= 0);

  const session = {
    date:        new Date().toISOString().split("T")[0],
    strategy:    ACTIVE,
    instrument:  INSTRUMENT,
    startTime:   ptState.sessionStart,
    endTime:     istNow(),
    trades:      ptState.sessionTrades,
    totalTrades: ptState.sessionTrades.length,
    wins:        wins.length,
    losses:      losses.length,
    winRate:     ptState.sessionTrades.length
                   ? `${((wins.length / ptState.sessionTrades.length) * 100).toFixed(1)}%`
                   : "N/A",
    sessionPnl:  ptState.sessionPnl,
  };

  data.sessions.push(session);
  data.totalPnl = parseFloat((data.totalPnl + ptState.sessionPnl).toFixed(2));

  // Accumulate capital from previous capital (not from env — that would reset it)
  data.capital = parseFloat((data.capital + ptState.sessionPnl).toFixed(2));

  savePaperData(data);
  log(`💾 Session saved. Running capital: ₹${data.capital} | Total PnL: ₹${data.totalPnl}`);

  return session;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * GET /paperTrade/start
 * Connects to live Fyers socket and starts simulating trades
 */
router.get("/start", async (req, res) => {
  if (!process.env.ACCESS_TOKEN) {
    return res.status(401).json({
      success: false,
      error: "Not authenticated. Visit /auth/login first.",
    });
  }

  if (ptState.running) {
    return res.status(400).json({ success: false, error: "Paper trading already running." });
  }

  if (sharedSocketState.isActive()) {
    return res.status(400).json({
      success: false,
      error: `Cannot start paper trading — Live Trading is currently active. Stop it first at /trade/stop`,
    });
  }

  if (!isMarketHours()) {
    return res.status(400).json({
      success: false,
      error: "Market is not open (9:15 AM – 3:20 PM IST). Paper trading uses live data.",
    });
  }

  const strategy    = getActiveStrategy();
  const accessToken = `${process.env.APP_ID}:${process.env.ACCESS_TOKEN}`;
  const subscribeSymbol = "NSE:NIFTY50-INDEX";
  const data        = loadPaperData();
  const todayStr    = new Date().toISOString().split("T")[0]; // "YYYY-MM-DD"

  // Reset session state
  ptState.running       = true;
  ptState.candles       = [];
  ptState.currentBar    = null;
  ptState.barStartTime  = null;
  ptState.position      = null;
  ptState.sessionTrades = [];
  ptState.sessionPnl    = 0;
  ptState.sessionStart  = istNow();
  ptState.log           = [];
  ptState.tickCount     = 0;
  ptState.lastTickTime  = null;
  ptState.lastTickPrice  = null;
  ptState.prevCandleHigh = null;
  ptState.prevCandleLow  = null;
  ptState.pendingEntry   = null;

  log(`🟡 [PAPER] Paper trading started`);
  log(`   Strategy   : ${ACTIVE} — ${strategy.NAME}`);
  log(`   Instrument : ${INSTRUMENT}`);
  log(`   Capital    : ₹${data.capital.toLocaleString("en-IN")}`);

  // ── PRE-LOAD today's historical candles so strategy fires immediately ────────
  // Without this, EMA (needs 25 candles) / RSI (needs 16) won't fire for hours
  try {
    log(`📥 Pre-loading today's candles (${todayStr}) so strategy is ready instantly...`);
    const { fetchCandles } = require("../services/backtestEngine");
    const todayCandles = await fetchCandles(subscribeSymbol, "5", todayStr, todayStr);

    if (todayCandles.length > 0) {
      // Load all but the last candle (last one is still forming — live ticks will complete it)
      ptState.candles = todayCandles.slice(0, -1);
      log(`✅ Pre-loaded ${ptState.candles.length} candles — strategy is ready immediately`);

      // Run a quick signal check on pre-loaded data to show current state
      const { signal, reason } = strategy.getSignal(ptState.candles);
      log(`📊 Current signal on pre-loaded data: ${signal} | ${reason}`);
    } else {
      log(`⚠️  No historical candles found for today — will build from live ticks (slow start)`);
    }
  } catch (err) {
    log(`⚠️  Could not pre-load candles: ${err.message} — will build from live ticks`);
  }

  log(`📡 Subscribing to ${subscribeSymbol} for live tick data...`);

  const skt = fyersDataSocket.getInstance(accessToken, "./logs", true);

  skt.on("connect", () => {
    log("📡 [PAPER] Socket connected — receiving live market data");
    skt.subscribe([subscribeSymbol]);
    skt.mode(skt.FullMode);
  });

  skt.on("message", (msg) => {
    if (Array.isArray(msg)) msg.forEach(onTick);
    else onTick(msg);
  });

  skt.on("error",  (err) => log(`❌ [PAPER] Socket error: ${JSON.stringify(err)}`));
  skt.on("close",  ()    => log("🔴 [PAPER] Socket closed"));

  skt.autoreconnect();
  skt.connect();
  ptState.socket = skt;
  sharedSocketState.setActive("PAPER_TRADE");

  return res.json({
    success:     true,
    message:     "Paper trading started! No real orders will be placed.",
    strategy:    { key: ACTIVE, name: strategy.NAME },
    instrument:  INSTRUMENT,
    lotQty:      getLotQty(),
    capital:     data.capital,
    monitorAt:   "GET /paperTrade/status",
  });
});

/**
 * GET /paperTrade/stop
 * Stops the session, squares off virtual position, saves summary to disk
 */
router.get("/stop", async (req, res) => {
  if (!ptState.running) {
    return res.status(400).json({ success: false, error: "Paper trading is not running." });
  }

  // Virtual square-off
  if (ptState.position && ptState.currentBar) {
    simulateSell(ptState.currentBar.close, "Manual stop");
  }

  if (ptState.socket) {
    ptState.socket.close();
    ptState.socket = null;
  }

  ptState.running = false;
  sharedSocketState.clear();
  log("🔴 [PAPER] Paper trading stopped");

  const session = saveSession();

  return res.json({
    success:  true,
    message:  "Paper trading stopped. Session saved.",
    session,
    viewHistory: "GET /paperTrade/history",
  });
});

/**
 * GET /paperTrade/status
 * Live view — current position, session PnL, capital, recent log
 */

// ── Session trade rows builder (avoids nested backtick issue) ────────────────
function buildSessionTradeRows(trades, inr) {
  if (!trades || trades.length === 0) return "";
  return [...trades].reverse().map(t => {
    const sc  = t.side === "CE" ? "#10b981" : "#ef4444";
    const pc  = t.pnl >= 0 ? "#10b981" : "#ef4444";
    const sl  = t.stopLoss ? inr(t.stopLoss) : "—";
    const why = (t.exitReason || "—").substring(0, 50);
    return "<tr style='border-top:1px solid #1a2236;'>" +
      "<td style='padding:10px 14px;color:" + sc + ";font-weight:700;'>" + t.side + "</td>" +
      "<td style='padding:10px 14px;'>" + (t.entryTime || "—") + "</td>" +
      "<td style='padding:10px 14px;'>" + (t.exitTime  || "—") + "</td>" +
      "<td style='padding:10px 14px;'>" + inr(t.entryPrice) + "</td>" +
      "<td style='padding:10px 14px;'>" + inr(t.exitPrice)  + "</td>" +
      "<td style='padding:10px 14px;color:#f59e0b;'>" + sl + "</td>" +
      "<td style='padding:10px 14px;color:" + pc + ";font-weight:700;'>" + inr(t.pnl) + "</td>" +
      "<td style='padding:10px 14px;font-size:0.72rem;color:#4a6080;'>" + why + "</td>" +
      "</tr>";
  }).join("");
}

router.get("/status", (req, res) => {
  const strategy = getActiveStrategy();
  const data     = loadPaperData();

  // Unrealised PnL if position is open
  let unrealisedPnl = 0;
  if (ptState.position && ptState.currentBar) {
    const { side, entryPrice, qty } = ptState.position;
    const ltp = ptState.currentBar.close;
    unrealisedPnl = parseFloat(
      ((ltp - entryPrice) * (side === "CE" ? 1 : -1) * qty).toFixed(2)
    );
  }

  const inr = (n) => typeof n === "number"
    ? `₹${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : "—";
  const pnlColor = (n) => n >= 0 ? "#10b981" : "#ef4444";

  const pos = ptState.position;
  const posHtml = pos ? `
    <div style="background:#0a1f0a;border:1px solid #065f46;border-radius:12px;padding:20px 24px;">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px;">
        <span style="width:10px;height:10px;border-radius:50%;background:#10b981;display:inline-block;animation:pulse 1.5s infinite;"></span>
        <span style="font-size:0.8rem;font-weight:700;color:#10b981;text-transform:uppercase;letter-spacing:1px;">Open Position</span>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:16px;">
        <div><div style="font-size:0.68rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Side</div>
          <div style="font-size:1.2rem;font-weight:700;color:${pos.side === "CE" ? "#10b981" : "#ef4444"};">${pos.side}</div></div>
        <div><div style="font-size:0.68rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Symbol</div>
          <div style="font-size:0.85rem;font-weight:600;color:#c8d8f0;font-family:monospace;">${pos.symbol}</div></div>
        <div><div style="font-size:0.68rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Entry Price</div>
          <div style="font-size:1rem;font-weight:700;color:#fff;">${inr(pos.entryPrice)}</div></div>
        <div><div style="font-size:0.68rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Current LTP</div>
          <div style="font-size:1rem;font-weight:700;color:#fff;">${inr(ptState.currentBar?.close)}</div></div>
        <div><div style="font-size:0.68rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Unrealised PnL</div>
          <div style="font-size:1.2rem;font-weight:700;color:${pnlColor(unrealisedPnl)};">${inr(unrealisedPnl)}</div></div>
        <div><div style="font-size:0.68rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Stop Loss</div>
          <div style="font-size:1rem;font-weight:600;color:#f59e0b;">${pos.stopLoss ? inr(pos.stopLoss) : "—"}</div></div>
        <div><div style="font-size:0.68rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Qty</div>
          <div style="font-size:1rem;font-weight:600;color:#fff;">${pos.qty}</div></div>
        <div><div style="font-size:0.68rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Entry Time</div>
          <div style="font-size:0.78rem;color:#c8d8f0;">${pos.entryTime}</div></div>
      </div>
      ${pos.reason ? `<div style="margin-top:14px;padding-top:14px;border-top:1px solid #065f46;font-size:0.75rem;color:#a7f3d0;">📝 ${pos.reason}</div>` : ""}
    </div>` : `
    <div style="background:${ptState.pendingEntry ? '#1c1400' : '#0d1320'};border:1px solid ${ptState.pendingEntry ? '#78350f' : '#1a2236'};border-radius:12px;padding:20px 24px;text-align:center;">
      ${ptState.pendingEntry
        ? `<div style="display:flex;align-items:center;gap:8px;justify-content:center;margin-bottom:8px;">
             <span style="width:9px;height:9px;border-radius:50%;background:#f59e0b;display:inline-block;animation:pulse 1s infinite;"></span>
             <span style="font-size:0.78rem;font-weight:700;color:#f59e0b;text-transform:uppercase;letter-spacing:1px;">Entry Queued — Waiting for next candle open</span>
           </div>
           <div style="font-size:1rem;font-weight:700;color:#f59e0b;">Will enter ${ptState.pendingEntry.side} at first tick of next 5-min candle</div>
           <div style="font-size:0.75rem;color:#4a6080;margin-top:6px;">${ptState.pendingEntry.reason || ""}</div>`
        : `<div style="font-size:1.5rem;margin-bottom:8px;">📭</div>
           <div style="font-size:0.9rem;font-weight:600;color:#4a6080;">FLAT — Waiting for entry signal</div>`
      }
    </div>`;

  const logHtml = ptState.log.slice(-30).reverse().map(l => {
    const color = l.includes("❌") ? "#ef4444" : l.includes("✅") ? "#10b981" : l.includes("🚨") ? "#f59e0b" : "#4a6080";
    return `<div style="padding:6px 0;border-bottom:1px solid #1a2236;font-size:0.74rem;font-family:monospace;color:${color};line-height:1.4;">${l}</div>`;
  }).join("");

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <meta http-equiv="refresh" content="5"/>
  <title>Paper Trading Status</title>
  <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet"/>
  <style>
    *{box-sizing:border-box;margin:0;padding:0;}
    body{font-family:'Space Grotesk',sans-serif;background:#080c14;color:#c8d8f0;padding-bottom:60px;}
    nav{display:flex;align-items:center;justify-content:space-between;padding:16px 32px;border-bottom:1px solid #1a2236;background:#0d1320;position:sticky;top:0;z-index:10;}
    nav .brand{font-size:1rem;font-weight:700;color:#fff;}nav .brand span{color:#3b82f6;}
    nav a{font-size:0.78rem;color:#4a6080;text-decoration:none;padding:6px 12px;border-radius:6px;border:1px solid transparent;}
    nav a:hover{color:#c8d8f0;border-color:#1a2236;background:#1a2236;}
    .page{max-width:1100px;margin:0 auto;padding:36px 24px;}
    .stat-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:14px;margin-bottom:24px;}
    .sc{background:#0d1320;border:1px solid #1a2236;border-radius:12px;padding:18px;}
    .sc-label{font-size:0.68rem;text-transform:uppercase;letter-spacing:1px;color:#4a6080;margin-bottom:8px;}
    .sc-val{font-size:1.4rem;font-weight:700;color:#fff;font-family:'JetBrains Mono',monospace;}
    .section-title{font-size:0.73rem;font-weight:600;text-transform:uppercase;letter-spacing:1.2px;color:#4a6080;margin-bottom:12px;display:flex;align-items:center;gap:10px;}
    .section-title::after{content:'';flex:1;height:1px;background:#1a2236;}
    .refresh-note{font-size:0.72rem;color:#4a6080;margin-top:8px;}
    @keyframes pulse{0%,100%{opacity:1}50%{opacity:0.3}}
  </style>
</head>
<body>
<nav>
  <div class="brand">📈 Fyers <span>Trading</span></div>
  <div style="display:flex;gap:8px;">
    <a href="/">Dashboard</a>
    <a href="/paperTrade/status" style="color:#f59e0b;border-color:#78350f;background:#2d1f00;">● Status</a>
    <a href="/paperTrade/history">History</a>
    <a href="/paperTrade/stop" style="color:#ef4444;">Stop</a>
  </div>
</nav>
<div class="page">
  <div style="margin-bottom:28px;">
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:8px;">
      ${ptState.running
        ? `<span style="width:10px;height:10px;border-radius:50%;background:#10b981;display:inline-block;animation:pulse 1.5s infinite;"></span><span style="font-size:0.8rem;font-weight:700;color:#10b981;text-transform:uppercase;letter-spacing:1px;">LIVE — Paper Trading</span>`
        : `<span style="width:10px;height:10px;border-radius:50%;background:#4a6080;display:inline-block;"></span><span style="font-size:0.8rem;font-weight:700;color:#4a6080;text-transform:uppercase;letter-spacing:1px;">STOPPED</span>`}
    </div>
    <h1 style="font-size:1.5rem;font-weight:700;color:#fff;letter-spacing:-0.5px;">Paper Trading Status</h1>
    <p style="font-size:0.85rem;color:#4a6080;margin-top:4px;">Strategy: <strong style="color:#3b82f6;">${ACTIVE} — ${strategy.NAME}</strong> &nbsp;·&nbsp; Auto-refreshes every 10s</p>
  </div>

  <div class="stat-grid">
    <div class="sc" style="border-top:2px solid #3b82f6;">
      <div class="sc-label">Starting Capital</div>
      <div class="sc-val">₹${getCapitalFromEnv().toLocaleString("en-IN")}</div>
    </div>
    <div class="sc" style="border-top:2px solid ${pnlColor(data.capital - getCapitalFromEnv())};">
      <div class="sc-label">Current Capital</div>
      <div class="sc-val" style="color:${pnlColor(data.capital - getCapitalFromEnv())};">${inr(data.capital)}</div>
    </div>
    <div class="sc" style="border-top:2px solid ${pnlColor(data.totalPnl)};">
      <div class="sc-label">All-Time PnL</div>
      <div class="sc-val" style="color:${pnlColor(data.totalPnl)};">${inr(data.totalPnl)}</div>
    </div>
    <div class="sc" style="border-top:2px solid ${pnlColor(ptState.sessionPnl)};">
      <div class="sc-label">Session PnL</div>
      <div class="sc-val" style="color:${pnlColor(ptState.sessionPnl)};">${inr(ptState.sessionPnl)}</div>
    </div>
    <div class="sc" style="border-top:2px solid #8b5cf6;">
      <div class="sc-label">Trades Today</div>
      <div class="sc-val">${ptState.sessionTrades.length}</div>
      <div style="font-size:0.7rem;color:#4a6080;margin-top:4px;">${ptState.sessionTrades.filter(t=>t.pnl>0).length}W &middot; ${ptState.sessionTrades.filter(t=>t.pnl<=0).length}L</div>
    </div>
    <div class="sc" style="border-top:2px solid #f59e0b;">
      <div class="sc-label">Candles Loaded</div>
      <div class="sc-val">${ptState.candles.length}</div>
      <div style="font-size:0.7rem;color:${ptState.candles.length >= 25 ? "#10b981" : "#f59e0b"};margin-top:4px;">${ptState.candles.length >= 25 ? "✅ Strategy ready" : "⚠️ Warming up..."}</div>
    </div>
    <div class="sc" style="border-top:2px solid #3b82f6;">
      <div class="sc-label">WebSocket Ticks</div>
      <div class="sc-val">${ptState.tickCount.toLocaleString()}</div>
      <div style="font-size:0.7rem;color:#4a6080;margin-top:4px;">Last: ${ptState.lastTickPrice ? inr(ptState.lastTickPrice) : "—"}</div>
    </div>
    <div class="sc" style="border-top:2px solid #4a6080;">
      <div class="sc-label">Session Start</div>
      <div class="sc-val" style="font-size:0.85rem;color:#c8d8f0;">${ptState.sessionStart || "—"}</div>
    </div>
    <div class="sc" style="border-top:2px solid #ef4444;">
      <div class="sc-label">Prev Candle High</div>
      <div class="sc-val" style="font-size:1rem;color:#ef4444;">${ptState.prevCandleHigh ? inr(ptState.prevCandleHigh) : "—"}</div>
      <div style="font-size:0.7rem;color:#4a6080;margin-top:4px;">PE exit trigger</div>
    </div>
    <div class="sc" style="border-top:2px solid #10b981;">
      <div class="sc-label">Prev Candle Low</div>
      <div class="sc-val" style="font-size:1rem;color:#10b981;">${ptState.prevCandleLow ? inr(ptState.prevCandleLow) : "—"}</div>
      <div style="font-size:0.7rem;color:#4a6080;margin-top:4px;">CE exit trigger</div>
    </div>
  </div>

  <div style="margin-bottom:24px;">
    <div class="section-title">Current Position</div>
    ${posHtml}
  </div>

  ${ptState.currentBar ? `
  <div style="margin-bottom:24px;">
    <div class="section-title">Current 5-Min Bar (forming)</div>
    <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:10px;">
      ${["open","high","low","close"].map(k => `
      <div class="sc">
        <div class="sc-label">${k.toUpperCase()}</div>
        <div class="sc-val" style="font-size:1rem;">${inr(ptState.currentBar[k])}</div>
      </div>`).join("")}
    </div>
  </div>` : ""}

  ${ptState.sessionTrades.length > 0 ? `
  <div style="margin-bottom:24px;">
    <div class="section-title">Today's Trades (newest first)</div>
    <div style="border:1px solid #1a2236;border-radius:12px;overflow:hidden;">
      <table style="width:100%;border-collapse:collapse;">
        <thead><tr style="background:#0a0f1c;">
          <th style="padding:10px 14px;text-align:left;font-size:0.63rem;text-transform:uppercase;letter-spacing:1px;color:#4a6080;font-weight:600;">Side</th>
          <th style="padding:10px 14px;text-align:left;font-size:0.63rem;text-transform:uppercase;letter-spacing:1px;color:#4a6080;font-weight:600;">Entry</th>
          <th style="padding:10px 14px;text-align:left;font-size:0.63rem;text-transform:uppercase;letter-spacing:1px;color:#4a6080;font-weight:600;">Exit</th>
          <th style="padding:10px 14px;text-align:left;font-size:0.63rem;text-transform:uppercase;letter-spacing:1px;color:#4a6080;font-weight:600;">Entry ₹</th>
          <th style="padding:10px 14px;text-align:left;font-size:0.63rem;text-transform:uppercase;letter-spacing:1px;color:#4a6080;font-weight:600;">Exit ₹</th>
          <th style="padding:10px 14px;text-align:left;font-size:0.63rem;text-transform:uppercase;letter-spacing:1px;color:#4a6080;font-weight:600;">SAR SL</th>
          <th style="padding:10px 14px;text-align:left;font-size:0.63rem;text-transform:uppercase;letter-spacing:1px;color:#4a6080;font-weight:600;">PnL</th>
          <th style="padding:10px 14px;text-align:left;font-size:0.63rem;text-transform:uppercase;letter-spacing:1px;color:#4a6080;font-weight:600;">Exit Reason</th>
        </tr></thead>
        <tbody style="font-family:'JetBrains Mono',monospace;font-size:0.8rem;">
          ${buildSessionTradeRows(ptState.sessionTrades, inr)}
        </tbody>
      </table>
    </div>
  </div>` : ""}

  <div>
    <div class="section-title">Recent Log (newest first)</div>
    <div style="background:#0d1320;border:1px solid #1a2236;border-radius:12px;padding:16px 20px;max-height:400px;overflow-y:auto;">
      ${logHtml || '<div style="color:#4a6080;font-size:0.82rem;">No log entries yet.</div>'}
    </div>
    <p class="refresh-note">🔄 Page auto-refreshes every 5 seconds</p>
  </div>
</div>
</body>
</html>`;

  res.setHeader("Content-Type", "text/html");
  return res.send(html);
});

/**
 * GET /paperTrade/history
 * All past paper trade sessions with summary stats
 */
router.get("/history", (req, res) => {
  const data = loadPaperData();

  const allTrades   = data.sessions.flatMap(s => s.trades || []);
  const totalWins   = allTrades.filter(t => t.pnl > 0).length;
  const totalLosses = allTrades.filter(t => t.pnl <= 0).length;
  const inr = (n) => typeof n === "number"
    ? `₹${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : "—";
  const pnlColor = (n) => (typeof n === "number" && n >= 0) ? "#10b981" : "#ef4444";

  const sessionCards = data.sessions.length === 0
    ? `<div style="text-align:center;padding:60px 24px;background:#0d1320;border:1px solid #1a2236;border-radius:14px;">
        <div style="font-size:3rem;margin-bottom:16px;">📭</div>
        <h3 style="font-size:1.1rem;font-weight:600;color:#fff;margin-bottom:8px;">No sessions yet</h3>
        <p style="font-size:0.85rem;color:#4a6080;">Start paper trading to record your first session.</p>
       </div>`
    : data.sessions.slice().reverse().map((s, idx) => {
        const sIdx = data.sessions.length - idx;
        const tradeRows = (s.trades || []).map(t => {
          const sideCls = t.side === "CE" ? "#10b981" : "#ef4444";
          return `<tr>
            <td style="color:${sideCls};font-weight:700;">${t.side}</td>
            <td>${t.entryTime || "—"}</td>
            <td>${t.exitTime  || "—"}</td>
            <td>${inr(t.entryPrice)}</td>
            <td>${inr(t.exitPrice)}</td>
            <td style="color:${pnlColor(t.pnl)};font-weight:700;">${inr(t.pnl)}</td>
            <td style="font-size:0.73rem;color:#4a6080;max-width:180px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${t.exitReason || "—"}</td>
          </tr>`;
        }).join("");

        return `
        <div style="background:#0d1320;border:1px solid #1a2236;border-radius:14px;overflow:hidden;margin-bottom:20px;">
          <div style="padding:18px 24px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #1a2236;background:#0a0f1c;">
            <div>
              <div style="font-size:0.68rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Session ${sIdx} · ${s.date}</div>
              <div style="font-size:1rem;font-weight:700;color:#fff;">${s.strategy} <span style="font-size:0.78rem;color:#4a6080;font-weight:400;">· ${s.instrument || "NIFTY"}</span></div>
            </div>
            <div style="text-align:right;">
              <div style="font-size:1.4rem;font-weight:700;color:${pnlColor(s.sessionPnl)};font-family:monospace;">${inr(s.sessionPnl)}</div>
              <div style="font-size:0.72rem;color:#4a6080;margin-top:2px;">${s.wins || 0}W · ${s.losses || 0}L · WR ${s.winRate || "—"}</div>
            </div>
          </div>
          ${s.trades && s.trades.length > 0 ? `
          <div style="overflow-x:auto;">
            <table style="width:100%;border-collapse:collapse;">
              <thead>
                <tr style="background:#080c14;">
                  <th style="padding:10px 16px;text-align:left;font-size:0.65rem;text-transform:uppercase;letter-spacing:1px;color:#4a6080;font-weight:600;">Side</th>
                  <th style="padding:10px 16px;text-align:left;font-size:0.65rem;text-transform:uppercase;letter-spacing:1px;color:#4a6080;font-weight:600;">Entry</th>
                  <th style="padding:10px 16px;text-align:left;font-size:0.65rem;text-transform:uppercase;letter-spacing:1px;color:#4a6080;font-weight:600;">Exit</th>
                  <th style="padding:10px 16px;text-align:left;font-size:0.65rem;text-transform:uppercase;letter-spacing:1px;color:#4a6080;font-weight:600;">Entry ₹</th>
                  <th style="padding:10px 16px;text-align:left;font-size:0.65rem;text-transform:uppercase;letter-spacing:1px;color:#4a6080;font-weight:600;">Exit ₹</th>
                  <th style="padding:10px 16px;text-align:left;font-size:0.65rem;text-transform:uppercase;letter-spacing:1px;color:#4a6080;font-weight:600;">PnL</th>
                  <th style="padding:10px 16px;text-align:left;font-size:0.65rem;text-transform:uppercase;letter-spacing:1px;color:#4a6080;font-weight:600;">Reason</th>
                </tr>
              </thead>
              <tbody style="font-family:'JetBrains Mono',monospace;font-size:0.82rem;">
                ${tradeRows}
              </tbody>
            </table>
          </div>` : `<div style="padding:16px 24px;color:#4a6080;font-size:0.82rem;">No trades in this session.</div>`}
        </div>`;
      }).join("");

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Paper Trade History</title>
  <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet"/>
  <style>
    *{box-sizing:border-box;margin:0;padding:0;}
    body{font-family:'Space Grotesk',sans-serif;background:#080c14;color:#c8d8f0;padding-bottom:60px;}
    nav{display:flex;align-items:center;justify-content:space-between;padding:16px 32px;border-bottom:1px solid #1a2236;background:#0d1320;position:sticky;top:0;z-index:10;}
    nav .brand{font-size:1rem;font-weight:700;color:#fff;}nav .brand span{color:#3b82f6;}
    nav a{font-size:0.78rem;color:#4a6080;text-decoration:none;padding:6px 12px;border-radius:6px;border:1px solid transparent;}
    nav a:hover{color:#c8d8f0;border-color:#1a2236;background:#1a2236;}
    .page{max-width:1100px;margin:0 auto;padding:36px 24px;}
    .stat-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:14px;margin-bottom:28px;}
    .sc{background:#0d1320;border:1px solid #1a2236;border-radius:12px;padding:18px;}
    .sc-label{font-size:0.68rem;text-transform:uppercase;letter-spacing:1px;color:#4a6080;margin-bottom:8px;}
    .sc-val{font-size:1.4rem;font-weight:700;font-family:'JetBrains Mono',monospace;}
    .section-title{font-size:0.73rem;font-weight:600;text-transform:uppercase;letter-spacing:1.2px;color:#4a6080;margin-bottom:14px;display:flex;align-items:center;gap:10px;}
    .section-title::after{content:'';flex:1;height:1px;background:#1a2236;}
    tbody tr{border-top:1px solid #1a2236;}tbody tr:hover{background:#0d1726;}
    tbody td{padding:11px 16px;}
  </style>
</head>
<body>
<nav>
  <div class="brand">📈 Fyers <span>Trading</span></div>
  <div style="display:flex;gap:8px;">
    <a href="/">Dashboard</a>
    <a href="/paperTrade/status">Status</a>
    <a href="/paperTrade/history" style="color:#f59e0b;border-color:#78350f;background:#2d1f00;">● History</a>
    <a href="/paperTrade/reset" style="color:#ef4444;" onclick="return confirm('Reset all paper trade data?')">Reset</a>
  </div>
</nav>
<div class="page">
  <div style="margin-bottom:28px;">
    <h1 style="font-size:1.5rem;font-weight:700;color:#fff;letter-spacing:-0.5px;">Paper Trade History</h1>
    <p style="font-size:0.85rem;color:#4a6080;margin-top:6px;">${data.sessions.length} sessions · ${allTrades.length} total trades</p>
  </div>

  <div class="stat-grid">
    <div class="sc" style="border-top:2px solid #3b82f6;">
      <div class="sc-label">Starting Capital</div>
      <div class="sc-val" style="color:#fff;">${inr(getCapitalFromEnv())}</div>
    </div>
    <div class="sc" style="border-top:2px solid ${pnlColor(data.capital - getCapitalFromEnv())};">
      <div class="sc-label">Current Capital</div>
      <div class="sc-val" style="color:${pnlColor(data.capital - getCapitalFromEnv())};">${inr(data.capital)}</div>
    </div>
    <div class="sc" style="border-top:2px solid ${pnlColor(data.totalPnl)};">
      <div class="sc-label">Total PnL</div>
      <div class="sc-val" style="color:${pnlColor(data.totalPnl)};">${inr(data.totalPnl)}</div>
    </div>
    <div class="sc" style="border-top:2px solid #10b981;">
      <div class="sc-label">Overall Win Rate</div>
      <div class="sc-val" style="color:#fff;">${allTrades.length ? ((totalWins / allTrades.length) * 100).toFixed(1) + "%" : "—"}</div>
      <div style="font-size:0.7rem;color:#4a6080;margin-top:4px;">${totalWins}W · ${totalLosses}L</div>
    </div>
    <div class="sc" style="border-top:2px solid #8b5cf6;">
      <div class="sc-label">Sessions</div>
      <div class="sc-val" style="color:#fff;">${data.sessions.length}</div>
    </div>
    <div class="sc" style="border-top:2px solid #f59e0b;">
      <div class="sc-label">Total Trades</div>
      <div class="sc-val" style="color:#fff;">${allTrades.length}</div>
    </div>
  </div>

  <div class="section-title">Sessions (newest first)</div>
  ${sessionCards}
</div>
</body>
</html>`;

  res.setHeader("Content-Type", "text/html");
  return res.send(html);
});

/**
 * GET /paperTrade/reset
 * Wipe all paper trade history and reset capital to .env default
 */
router.get("/reset", (req, res) => {
  if (ptState.running) {
    return res.status(400).json({
      success: false,
      error: "Stop paper trading first before resetting.",
    });
  }

  const freshCapital = getCapitalFromEnv();
  savePaperData({ capital: freshCapital, totalPnl: 0, sessions: [] });

  log(`🔄 Paper trade data reset. Capital restored to ₹${freshCapital.toLocaleString("en-IN")}`);

  return res.json({
    success: true,
    message: `Paper trade history cleared. Capital reset to ₹${freshCapital.toLocaleString("en-IN")}`,
  });
});

module.exports = router;

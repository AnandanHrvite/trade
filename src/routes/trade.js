const express = require("express");
const router = express.Router();
const { fyersDataSocket } = require("fyers-api-v3");
const fyers = require("../config/fyers");
const { getActiveStrategy, ACTIVE } = require("../strategies");
const { getSymbol, getLotQty, getProductType, INSTRUMENT } = require("../config/instrument");

// Shared socket state — prevents paperTrade and liveTrade running at the same time
// since fyersDataSocket is a singleton per access token
const sharedSocketState = require("../utils/sharedSocketState");

let tradeState = {
  running: false,
  position: null,    // null when flat, { side, symbol, qty, entryPrice, entryTime } when in trade
  candles: [],
  log: [],
  socket: null,
  currentBar: null,  // building the current 5-min bar from ticks
  barStartTime: null,
};

// ── Helpers ─────────────────────────────────────────────────────────────────

function log(msg) {
  const entry = `[${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}] ${msg}`;
  console.log(entry);
  tradeState.log.push(entry);
  if (tradeState.log.length > 200) tradeState.log.shift(); // keep last 200 lines
}

function get5MinBucketStart(unixMs) {
  const d = new Date(unixMs);
  const mins = d.getMinutes();
  d.setMinutes(Math.floor(mins / 5) * 5, 0, 0);
  return d.getTime();
}

function isMarketHours() {
  const now = new Date();
  const ist = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const h = ist.getHours();
  const m = ist.getMinutes();
  const totalMin = h * 60 + m;
  return totalMin >= 555 && totalMin < 920; // 9:15 AM to 3:20 PM
}

// ── Place market order ───────────────────────────────────────────────────────

async function placeMarketOrder(symbol, side, qty) {
  // side: 1 = BUY, -1 = SELL
  try {
    const response = await fyers.place_order({
      symbol,
      qty,
      type: 2,              // 2 = Market order
      side,                 // 1=Buy, -1=Sell
      productType: getProductType(),
      limitPrice: 0,
      stopPrice: 0,
      validity: "DAY",
      disclosedQty: 0,
      offlineOrder: false,
      orderTag: `${ACTIVE}_LIVE`,
    });

    if (response.s === "ok") {
      log(`✅ Order placed — ${side === 1 ? "BUY" : "SELL"} ${qty} ${symbol} | OrderID: ${response.id}`);
    } else {
      log(`❌ Order failed — ${JSON.stringify(response)}`);
    }
    return response;
  } catch (err) {
    log(`❌ Order error — ${err.message}`);
    throw err;
  }
}

// ── Square off open position ─────────────────────────────────────────────────

async function squareOff(exitPrice, reason) {
  if (!tradeState.position) return;

  const { symbol, qty } = tradeState.position;
  const exitSide = -1; // always sell to exit (both CE and PE are bought)

  log(`🔄 Squaring off: ${reason} — SELL ${qty} ${symbol}`);
  await placeMarketOrder(symbol, exitSide, qty);

  const pnl = (exitPrice - tradeState.position.entryPrice) * qty;
  log(`💰 PnL for this trade: ₹${pnl.toFixed(2)}`);

  tradeState.position = null;
}

// ── On each completed 5-min candle ──────────────────────────────────────────

async function onCandleClose(candle) {
  tradeState.candles.push(candle);
  if (tradeState.candles.length > 200) tradeState.candles.shift();

  const strategy = getActiveStrategy();
  const { signal, reason, stopLoss } = strategy.getSignal(tradeState.candles);

  log(`📊 Candle close — ${candle.close} | Signal: ${signal} | ${reason}`);

  // Dynamic SL update — if strategy returns a new SL (SAR-based), update position SL each candle
  if (tradeState.position && stopLoss !== null && stopLoss !== undefined) {
    const oldSL = tradeState.position.stopLoss;
    tradeState.position.stopLoss = stopLoss;
    if (oldSL !== stopLoss) {
      log(`🔄 SL updated: ${oldSL} → ${stopLoss} (trailing SAR)`);
    }
  }

  // ── EOD square-off at 3:20 PM ──────────────────────────────────────────
  const now = new Date();
  const ist = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  if (ist.getHours() * 60 + ist.getMinutes() >= 920) {
    if (tradeState.position) {
      await squareOff(candle.close, "EOD square-off 3:20 PM");
    }
    return;
  }

  // ── Stoploss check on candle CLOSE ─────────────────────────────────────
  if (tradeState.position && tradeState.position.stopLoss != null) {
    const sl = tradeState.position.stopLoss;
    if (tradeState.position.side === "CE" && candle.close < sl) {
      log(`🚨 Stoploss hit — candle closed @ ${candle.close} below SL ${sl}`);
      await squareOff(candle.close, `Stoploss hit — candle closed @ ${candle.close} below SL ${sl}`);
      return;
    }
    if (tradeState.position.side === "PE" && candle.close > sl) {
      log(`🚨 Stoploss hit — candle closed @ ${candle.close} above SL ${sl}`);
      await squareOff(candle.close, `Stoploss hit — candle closed @ ${candle.close} above SL ${sl}`);
      return;
    }
  }

  // ── Exit logic ─────────────────────────────────────────────────────────
  if (tradeState.position) {
    const oppSignal = tradeState.position.side === "CE" ? "BUY_PE" : "BUY_CE";
    if (signal === oppSignal) {
      await squareOff(candle.close, "Opposite signal exit");
    }
  }

  // ── Entry logic ────────────────────────────────────────────────────────
  if (!tradeState.position && signal !== "NONE") {
    const side   = signal === "BUY_CE" ? "CE" : "PE";
    const symbol = await getSymbol(side);   // async — fetches live spot + builds symbol
    const qty    = getLotQty();

    log(`🚀 Entry signal: ${signal} — BUY ${qty} ${symbol}${stopLoss ? ` | SL: ${stopLoss}` : ""}`);
    await placeMarketOrder(symbol, 1, qty);

    tradeState.position = {
      side,
      symbol,
      qty,
      entryPrice: candle.close,
      entryTime:  new Date().toISOString(),
      stopLoss:   stopLoss || null,
      reason,
    };
  }
}

// ── Tick aggregator → 5-min candle builder ──────────────────────────────────

function onTick(tick) {
  if (!tick || !tick.ltp) return;

  const now = Date.now();
  const bucketStart = get5MinBucketStart(now);

  if (!tradeState.currentBar || tradeState.barStartTime !== bucketStart) {
    // New 5-min bar started — close previous bar
    if (tradeState.currentBar) {
      onCandleClose(tradeState.currentBar).catch(console.error);
    }
    tradeState.currentBar = {
      time: Math.floor(bucketStart / 1000),
      open: tick.ltp,
      high: tick.ltp,
      low: tick.ltp,
      close: tick.ltp,
      volume: tick.vol_traded_today || 0,
    };
    tradeState.barStartTime = bucketStart;
  } else {
    // Update current bar
    const bar = tradeState.currentBar;
    bar.high = Math.max(bar.high, tick.ltp);
    bar.low = Math.min(bar.low, tick.ltp);
    bar.close = tick.ltp;
    bar.volume = tick.vol_traded_today || bar.volume;
  }
}

// ── Routes ───────────────────────────────────────────────────────────────────

/**
 * GET /trade/start
 * Starts live trading with the active strategy
 * Browser: http://localhost:3000/trade/start
 */
router.get("/start", async (req, res) => {
  if (!process.env.ACCESS_TOKEN) {
    return res.status(401).json({
      success: false,
      error: "Not authenticated. Visit /auth/login first.",
    });
  }

  if (process.env.LIVE_TRADE_ENABLED !== "true") {
    return res.status(403).json({
      success: false,
      error: "Live trading is disabled. Set LIVE_TRADE_ENABLED=true in .env to enable.",
    });
  }

  if (tradeState.running) {
    return res.status(400).json({ success: false, error: "Trading is already running." });
  }

  if (sharedSocketState.isActive()) {
    return res.status(400).json({
      success: false,
      error: `Cannot start live trading — Paper Trading is currently active. Stop it first at /paperTrade/stop`,
    });
  }

  if (!isMarketHours()) {
    return res.status(400).json({
      success: false,
      error: "Market is not open. Trading hours are 9:15 AM – 3:20 PM IST.",
    });
  }

  const strategy = getActiveStrategy();
  const accessToken = `${process.env.APP_ID}:${process.env.ACCESS_TOKEN}`;
  const subscribeSymbol = "NSE:NIFTY50-INDEX";
  const todayStr = new Date().toISOString().split("T")[0];

  log(`🟢 Starting live trading — Strategy: ${ACTIVE} | Instrument: ${INSTRUMENT}`);

  // ── Reset state ────────────────────────────────────────────────────────
  tradeState.running     = true;
  tradeState.candles     = [];
  tradeState.log         = [];
  tradeState.position    = null;
  tradeState.currentBar  = null;
  tradeState.barStartTime = null;

  // ── Pre-load today's candles so strategy is ready immediately ──────────
  try {
    log(`📥 Pre-loading today's candles (${todayStr})...`);
    const { fetchCandles } = require("../services/backtestEngine");
    const todayCandles = await fetchCandles(subscribeSymbol, "5", todayStr, todayStr);
    if (todayCandles.length > 0) {
      tradeState.candles = todayCandles.slice(0, -1); // exclude last (still forming)
      log(`✅ Pre-loaded ${tradeState.candles.length} candles — strategy ready immediately`);
      const { signal, reason } = strategy.getSignal(tradeState.candles);
      log(`📊 Signal on pre-loaded data: ${signal} | ${reason}`);
    } else {
      log(`⚠️  No candles for today yet — will build from live ticks`);
    }
  } catch (err) {
    log(`⚠️  Could not pre-load candles: ${err.message} — will build from live ticks`);
  }

  log(`📡 Subscribing to ${subscribeSymbol} ticks...`);

  const skt = fyersDataSocket.getInstance(accessToken, "./logs", true);

  skt.on("connect", () => {
    log("📡 Data socket connected");
    skt.subscribe([subscribeSymbol]);
    skt.mode(skt.FullMode);
  });

  skt.on("message", (message) => {
    if (Array.isArray(message)) {
      message.forEach((tick) => onTick(tick));
    } else {
      onTick(message);
    }
  });

  skt.on("error", (err) => log(`❌ Socket error: ${JSON.stringify(err)}`));
  skt.on("close", () => log("🔴 Data socket closed"));

  skt.autoreconnect();
  skt.connect();

  tradeState.socket = skt;
  sharedSocketState.setActive("LIVE_TRADE");

  res.json({
    success: true,
    message: `Live trading started with ${ACTIVE}`,
    instrument: INSTRUMENT,
    strategy: { name: strategy.NAME, description: strategy.DESCRIPTION },
    lotQty: getLotQty(),
  });
});

/**
 * GET /trade/stop
 * Stops live trading and squares off any open position
 * Browser: http://localhost:3000/trade/stop
 */
router.get("/stop", async (req, res) => {
  if (!tradeState.running) {
    return res.status(400).json({ success: false, error: "Trading is not running." });
  }

  if (tradeState.position && tradeState.currentBar) {
    log("🛑 Manual stop — squaring off open position");
    await squareOff(tradeState.currentBar.close, "Manual stop");
  }

  if (tradeState.socket) {
    tradeState.socket.close();
    tradeState.socket = null;
  }

  tradeState.running = false;
  sharedSocketState.clear();
  log("🔴 Live trading stopped");

  res.json({ success: true, message: "Trading stopped and position squared off." });
});

/**
 * GET /trade/status
 * Returns current trading state
 */
router.get("/status", (req, res) => {
  const strategy      = getActiveStrategy();
  const liveEnabled   = process.env.LIVE_TRADE_ENABLED === "true";
  const pos           = tradeState.position;

  const inr = (n) => typeof n === "number"
    ? `₹${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : "—";
  const pnlColor = (n) => (typeof n === "number" && n >= 0) ? "#10b981" : "#ef4444";

  // Unrealised PnL on current bar
  let unrealisedPnl = 0;
  if (pos && tradeState.currentBar) {
    unrealisedPnl = parseFloat(
      ((tradeState.currentBar.close - pos.entryPrice) * (pos.side === "CE" ? 1 : -1) * pos.qty).toFixed(2)
    );
  }

  const posHtml = pos ? `
    <div style="background:#0a1f0a;border:1px solid #065f46;border-radius:12px;padding:20px 24px;">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px;">
        <span style="width:10px;height:10px;border-radius:50%;background:#10b981;display:inline-block;animation:pulse 1.5s infinite;"></span>
        <span style="font-size:0.8rem;font-weight:700;color:#10b981;text-transform:uppercase;letter-spacing:1px;">⚡ LIVE Position</span>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:16px;">
        <div><div style="font-size:0.68rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Side</div>
          <div style="font-size:1.2rem;font-weight:700;color:${pos.side === "CE" ? "#10b981" : "#ef4444"};">${pos.side}</div></div>
        <div><div style="font-size:0.68rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Symbol</div>
          <div style="font-size:0.82rem;font-weight:600;color:#c8d8f0;font-family:monospace;">${pos.symbol}</div></div>
        <div><div style="font-size:0.68rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Entry Price</div>
          <div style="font-size:1rem;font-weight:700;color:#fff;">${inr(pos.entryPrice)}</div></div>
        <div><div style="font-size:0.68rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Current LTP</div>
          <div style="font-size:1rem;font-weight:700;color:#fff;">${inr(tradeState.currentBar?.close)}</div></div>
        <div><div style="font-size:0.68rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Unrealised PnL</div>
          <div style="font-size:1.2rem;font-weight:700;color:${pnlColor(unrealisedPnl)};">${inr(unrealisedPnl)}</div></div>
        <div><div style="font-size:0.68rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Stop Loss</div>
          <div style="font-size:1rem;font-weight:600;color:#f59e0b;">${pos.stopLoss ? inr(pos.stopLoss) : "—"}</div></div>
        <div><div style="font-size:0.68rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Qty</div>
          <div style="font-size:1rem;font-weight:600;color:#fff;">${pos.qty}</div></div>
        <div><div style="font-size:0.68rem;color:#4a6080;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Entry Time</div>
          <div style="font-size:0.75rem;color:#c8d8f0;">${new Date(pos.entryTime).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}</div></div>
      </div>
      ${pos.reason ? `<div style="margin-top:14px;padding-top:14px;border-top:1px solid #065f46;font-size:0.75rem;color:#a7f3d0;">📝 ${pos.reason}</div>` : ""}
    </div>` : `
    <div style="background:#0d1320;border:1px solid #1a2236;border-radius:12px;padding:20px 24px;text-align:center;">
      <div style="font-size:1.5rem;margin-bottom:8px;">📭</div>
      <div style="font-size:0.9rem;font-weight:600;color:#4a6080;">FLAT — No open position</div>
    </div>`;

  const logHtml = tradeState.log.slice(-30).reverse().map(l => {
    const color = l.includes("❌") ? "#ef4444"
                : l.includes("✅") ? "#10b981"
                : l.includes("🚨") ? "#f59e0b"
                : l.includes("🚀") ? "#3b82f6"
                : "#4a6080";
    return `<div style="padding:6px 0;border-bottom:1px solid #1a2236;font-size:0.74rem;font-family:monospace;color:${color};line-height:1.4;">${l}</div>`;
  }).join("");

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <meta http-equiv="refresh" content="10"/>
  <title>Live Trade Status</title>
  <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet"/>
  <style>
    *{box-sizing:border-box;margin:0;padding:0;}
    body{font-family:'Space Grotesk',sans-serif;background:#080c14;color:#c8d8f0;padding-bottom:60px;}
    nav{display:flex;align-items:center;justify-content:space-between;padding:16px 32px;border-bottom:1px solid #1a2236;background:#0d1320;position:sticky;top:0;z-index:10;}
    nav .brand{font-size:1rem;font-weight:700;color:#fff;}
    nav .brand span{color:#3b82f6;}
    nav a{font-size:0.78rem;color:#4a6080;text-decoration:none;padding:6px 12px;border-radius:6px;border:1px solid transparent;transition:all 0.15s;}
    nav a:hover{color:#c8d8f0;border-color:#1a2236;background:#1a2236;}
    .page{max-width:1100px;margin:0 auto;padding:36px 24px;}
    .stat-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:14px;margin-bottom:24px;}
    .sc{background:#0d1320;border:1px solid #1a2236;border-radius:12px;padding:18px;}
    .sc-label{font-size:0.68rem;text-transform:uppercase;letter-spacing:1px;color:#4a6080;margin-bottom:8px;}
    .sc-val{font-size:1.3rem;font-weight:700;color:#fff;font-family:'JetBrains Mono',monospace;}
    .section-title{font-size:0.73rem;font-weight:600;text-transform:uppercase;letter-spacing:1.2px;color:#4a6080;margin-bottom:12px;display:flex;align-items:center;gap:10px;}
    .section-title::after{content:'';flex:1;height:1px;background:#1a2236;}
    @keyframes pulse{0%,100%{opacity:1}50%{opacity:0.3}}
    .warning-banner{background:#2d1000;border:1px solid #7c2d12;border-radius:10px;padding:14px 20px;margin-bottom:20px;font-size:0.85rem;color:#fed7aa;}
  </style>
</head>
<body>
<nav>
  <div class="brand">📈 Fyers <span>Trading</span></div>
  <div style="display:flex;gap:8px;">
    <a href="/">Dashboard</a>
    <a href="/trade/status" style="color:#ef4444;border-color:#7f1d1d;background:#2d0a0a;">⚡ Live Status</a>
    <a href="/trade/stop" style="color:#ef4444;" onclick="return confirm('Stop live trading and square off position?')">■ Stop</a>
    <a href="/paperTrade/status">Paper Status</a>
  </div>
</nav>
<div class="page">

  <div style="margin-bottom:28px;">
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:8px;">
      ${tradeState.running
        ? `<span style="width:10px;height:10px;border-radius:50%;background:#ef4444;display:inline-block;animation:pulse 1.5s infinite;"></span>
           <span style="font-size:0.8rem;font-weight:700;color:#ef4444;text-transform:uppercase;letter-spacing:1px;">⚡ LIVE TRADING ACTIVE</span>`
        : `<span style="width:10px;height:10px;border-radius:50%;background:#4a6080;display:inline-block;"></span>
           <span style="font-size:0.8rem;font-weight:700;color:#4a6080;text-transform:uppercase;letter-spacing:1px;">STOPPED</span>`}
    </div>
    <h1 style="font-size:1.5rem;font-weight:700;color:#fff;letter-spacing:-0.5px;">Live Trading Status</h1>
    <p style="font-size:0.85rem;color:#4a6080;margin-top:4px;">
      Strategy: <strong style="color:#3b82f6;">${ACTIVE} — ${strategy.NAME}</strong>
      &nbsp;·&nbsp; Instrument: <strong style="color:#c8d8f0;">${INSTRUMENT}</strong>
      &nbsp;·&nbsp; Auto-refreshes every 10s
    </p>
  </div>

  ${!liveEnabled ? `<div class="warning-banner">⚠️ <strong>Live trading is DISABLED</strong> — Set <code style="background:#1a0a00;padding:2px 6px;border-radius:4px;font-family:monospace;">LIVE_TRADE_ENABLED=true</code> in your .env to enable real order placement.</div>` : ""}

  <div class="stat-grid">
    <div class="sc" style="border-top:2px solid ${tradeState.running ? "#ef4444" : "#4a6080"};">
      <div class="sc-label">Status</div>
      <div class="sc-val" style="font-size:1rem;color:${tradeState.running ? "#ef4444" : "#4a6080"};">${tradeState.running ? "⚡ RUNNING" : "● STOPPED"}</div>
    </div>
    <div class="sc" style="border-top:2px solid ${liveEnabled ? "#ef4444" : "#f59e0b"};">
      <div class="sc-label">Live Orders</div>
      <div class="sc-val" style="font-size:1rem;color:${liveEnabled ? "#ef4444" : "#f59e0b"};">${liveEnabled ? "✅ ENABLED" : "🔒 DISABLED"}</div>
    </div>
    <div class="sc" style="border-top:2px solid #8b5cf6;">
      <div class="sc-label">Candles Loaded</div>
      <div class="sc-val">${tradeState.candles.length}</div>
      <div style="font-size:0.7rem;color:${tradeState.candles.length >= 25 ? "#10b981" : "#f59e0b"};margin-top:4px;">${tradeState.candles.length >= 25 ? "✅ Strategy ready" : "⚠️ Warming up..."}</div>
    </div>
    <div class="sc" style="border-top:2px solid #3b82f6;">
      <div class="sc-label">Lot Qty</div>
      <div class="sc-val">${getLotQty()}</div>
      <div style="font-size:0.7rem;color:#4a6080;margin-top:4px;">1 lot = 75 units</div>
    </div>
    ${tradeState.currentBar ? `
    <div class="sc" style="border-top:2px solid #10b981;">
      <div class="sc-label">Current LTP</div>
      <div class="sc-val">${inr(tradeState.currentBar.close)}</div>
      <div style="font-size:0.7rem;color:#4a6080;margin-top:4px;">H: ${inr(tradeState.currentBar.high)} · L: ${inr(tradeState.currentBar.low)}</div>
    </div>` : `
    <div class="sc" style="border-top:2px solid #4a6080;">
      <div class="sc-label">Current LTP</div>
      <div class="sc-val" style="color:#4a6080;">—</div>
      <div style="font-size:0.7rem;color:#4a6080;margin-top:4px;">No ticks yet</div>
    </div>`}
    <div class="sc" style="border-top:2px solid ${pos ? "#10b981" : "#4a6080"};">
      <div class="sc-label">Position</div>
      <div class="sc-val" style="font-size:1rem;color:${pos ? "#10b981" : "#4a6080"};">${pos ? pos.side + " OPEN" : "FLAT"}</div>
      ${pos ? `<div style="font-size:0.7rem;color:${pnlColor(unrealisedPnl)};margin-top:4px;">${inr(unrealisedPnl)} unrealised</div>` : ""}
    </div>
  </div>

  <div style="margin-bottom:24px;">
    <div class="section-title">Current Position</div>
    ${posHtml}
  </div>

  ${tradeState.currentBar ? `
  <div style="margin-bottom:24px;">
    <div class="section-title">Current 5-Min Bar (forming)</div>
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;">
      ${["open","high","low","close"].map(k => `
      <div class="sc">
        <div class="sc-label">${k.toUpperCase()}</div>
        <div class="sc-val" style="font-size:1rem;">${inr(tradeState.currentBar[k])}</div>
      </div>`).join("")}
    </div>
  </div>` : ""}

  <div>
    <div class="section-title">Activity Log (newest first)</div>
    <div style="background:#0d1320;border:1px solid #1a2236;border-radius:12px;padding:16px 20px;max-height:400px;overflow-y:auto;">
      ${logHtml || '<div style="color:#4a6080;font-size:0.82rem;">No activity yet. Start trading to see log entries.</div>'}
    </div>
    <p style="font-size:0.72rem;color:#4a6080;margin-top:8px;">🔄 Page auto-refreshes every 10 seconds</p>
  </div>

</div>
</body>
</html>`;

  res.setHeader("Content-Type", "text/html");
  return res.send(html);
});

module.exports = router;

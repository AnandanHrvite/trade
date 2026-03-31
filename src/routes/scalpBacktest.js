/**
 * SCALP BACKTEST — /scalp-backtest
 * ─────────────────────────────────────────────────────────────────────────────
 * Backtests the scalp strategy (BB + CPR + RSI + PSAR trail) on 3/5-min candles.
 * Uses Fyers historical API for candle data. Completely independent from
 * the main backtest route.
 *
 * Routes:
 *   GET /scalp-backtest  → Run backtest with query params
 * ─────────────────────────────────────────────────────────────────────────────
 */

const express = require("express");
const router  = express.Router();
const { fetchCandles } = require("../services/backtestEngine");
const scalpStrategy    = require("../strategies/scalp_bb_cpr");
const { saveResult }   = require("../utils/resultStore");
const sharedSocketState = require("../utils/sharedSocketState");
const { buildSidebar, sidebarCSS, modalCSS, modalJS } = require("../utils/sharedNav");
const vixFilter = require("../services/vixFilter");
const { VIX_SYMBOL } = vixFilter;
const instrumentConfig = require("../config/instrument");
const { getLotQty } = instrumentConfig;

const inr = (n) => typeof n === "number" ? "\u20b9" + n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "\u2014";
const pts = (n) => typeof n === "number" ? (n >= 0 ? "+" : "") + n.toFixed(2) + " pts" : "\u2014";
const pnlColor = (n) => (typeof n === "number" && n >= 0) ? "#10b981" : "#ef4444";
const fmtPnl   = (n, s) => {
  if (typeof n !== "number") return "\u2014";
  if (s && s.optionSim) return (n >= 0 ? "+" : "") + "\u20b9" + Math.abs(n).toLocaleString("en-IN", { maximumFractionDigits: 0 });
  return pts(n);
};

// ── Build daily OHLC lookup from intraday candles ────────────────────────────
function buildDailyOHLC(candles) {
  const days = {};
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const dateStr = new Date(c.time * 1000).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    if (!days[dateStr]) {
      days[dateStr] = { high: c.high, low: c.low, close: c.close, open: c.open };
    } else {
      if (c.high > days[dateStr].high) days[dateStr].high = c.high;
      if (c.low  < days[dateStr].low)  days[dateStr].low  = c.low;
      days[dateStr].close = c.close;  // last candle's close = day close
    }
  }
  return days;
}

// ── Scalp Backtest Engine ─────────────────────────────────────────────────────
function runScalpBacktest(candles, capital, vixCandles) {
  const trades   = [];
  let position   = null;
  const BROKERAGE = 80;
  const LOT_SIZE  = getLotQty();

  // VIX
  const lookupVix = vixFilter.buildVixLookup(vixCandles || []);

  // Option sim
  const isFutures   = instrumentConfig.INSTRUMENT === "NIFTY_FUTURES";
  const OPTION_SIM  = isFutures ? false : (process.env.BACKTEST_OPTION_SIM !== "false");
  const DELTA       = isFutures ? 1.0 : parseFloat(process.env.BACKTEST_DELTA || "0.55");
  const THETA_DAY   = isFutures ? 0   : parseFloat(process.env.BACKTEST_THETA_DAY || "10");
  const SCALP_RES   = parseInt(process.env.SCALP_RESOLUTION || "3", 10);
  const CANDLES_PER_DAY = Math.round(390 / SCALP_RES); // 6.5h trading day

  // Scalp config (new BB+CPR strategy — no fixed SL/target/trail)
  const SCALP_MAX_TRADES    = parseInt(process.env.SCALP_MAX_DAILY_TRADES || "30", 10);
  const SCALP_MAX_LOSS      = parseFloat(process.env.SCALP_MAX_DAILY_LOSS || "2000");
  const SCALP_PAUSE_CANDLES = parseInt(process.env.SCALP_SL_PAUSE_CANDLES || "2", 10);

  function getISTDateStr(unixSec) {
    return new Date(unixSec * 1000).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  }
  function getISTHHMM(unixSec) {
    const d = new Date(new Date(unixSec * 1000).toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
    return d.getHours() * 60 + d.getMinutes();
  }
  function toIST(unixSec) {
    return new Date(unixSec * 1000).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: false });
  }

  if (typeof scalpStrategy.reset === "function") scalpStrategy.reset();

  // Build daily OHLC for CPR calculation
  const dailyOHLC = buildDailyOHLC(candles);
  const sortedDates = Object.keys(dailyOHLC).sort();

  console.log("\n══════════════════════════════════════════════");
  console.log(`🔍 SCALP BACKTEST — ${scalpStrategy.NAME}`);
  console.log(`   Candles: ${candles.length} | PSAR trailing SL | BB+CPR entry`);
  console.log(`   MaxTrades: ${SCALP_MAX_TRADES}/day | MaxLoss: ₹${SCALP_MAX_LOSS}/day`);
  console.log(`   Days with data: ${sortedDates.length}`);
  console.log("══════════════════════════════════════════════");

  const window = candles.slice(0, 30);
  let _slPauseUntilTs = 0;
  let _dailyTradeCount = 0;
  let _dailyPnl = 0;
  let _prevDate = null;

  for (let i = 30; i < candles.length; i++) {
    const candle = candles[i];
    const candleDate = getISTDateStr(candle.time);
    const candleMin  = getISTHHMM(candle.time);

    // New day reset
    if (_prevDate && candleDate !== _prevDate) {
      _dailyTradeCount = 0;
      _dailyPnl = 0;
      _slPauseUntilTs = 0;
    }
    _prevDate = candleDate;

    window.push(candle);
    if (window.length > 100) window.shift();

    const isEOD = candleMin >= 920; // 3:20 PM

    // Get prev day OHLC for CPR
    const dateIdx = sortedDates.indexOf(candleDate);
    const prevDayOHLC     = dateIdx > 0 ? dailyOHLC[sortedDates[dateIdx - 1]] : null;
    const prevPrevDayOHLC = dateIdx > 1 ? dailyOHLC[sortedDates[dateIdx - 2]] : null;

    // ── EXIT LOGIC ──────────────────────────────────────────────────────────
    if (position) {
      position.candlesHeld = (position.candlesHeld || 0) + 1;

      let exitReason = null;
      let exitPrice  = candle.close;

      // 1. PSAR flip → immediate exit
      if (scalpStrategy.isPSARFlip(window, position.side)) {
        exitReason = "PSAR flip";
      }

      // 2. SL hit (intra-candle check against PSAR-based SL)
      if (!exitReason) {
        const _isTrail = position.initialStopLoss != null && Math.abs(position.stopLoss - position.initialStopLoss) > 0.5;
        const _slLabel = _isTrail ? "PSAR Trail SL" : "PSAR SL";
        if (position.side === "CE" && candle.low <= position.stopLoss) {
          exitPrice  = position.stopLoss;
          exitReason = `${_slLabel} hit`;
        } else if (position.side === "PE" && candle.high >= position.stopLoss) {
          exitPrice  = position.stopLoss;
          exitReason = `${_slLabel} hit`;
        }
      }

      // 3. Update PSAR trailing SL (tighten only)
      if (!exitReason) {
        const newSL = scalpStrategy.updateTrailingSL(window, position.stopLoss, position.side);
        if (newSL !== position.stopLoss) {
          position.stopLoss = newSL;
        }
      }

      // 4. EOD
      if (!exitReason && isEOD) {
        exitReason = "EOD square-off";
      }

      if (exitReason) {
        const spotPnlPts = (exitPrice - position.entryPrice) * (position.side === "CE" ? 1 : -1);
        let pnl;
        if (OPTION_SIM) {
          const thetaCost = (THETA_DAY * position.candlesHeld) / CANDLES_PER_DAY;
          pnl = parseFloat(((spotPnlPts * DELTA * LOT_SIZE) - thetaCost - BROKERAGE).toFixed(2));
        } else {
          pnl = parseFloat((spotPnlPts - BROKERAGE / LOT_SIZE).toFixed(2));
        }

        trades.push({
          side:         position.side,
          entryPrice:   position.entryPrice,
          exitPrice,
          entryTime:    toIST(position.entryTs),
          exitTime:     toIST(candle.time),
          entryTs:      position.entryTs,
          exitTs:       candle.time,
          stopLoss:     position.stopLoss,
          initialStopLoss: position.initialStopLoss,
          target:       null,
          pnl,
          spotPnlPts:   parseFloat(spotPnlPts.toFixed(2)),
          candlesHeld:  position.candlesHeld,
          exitReason,
          pnlMode:      OPTION_SIM ? "option sim" : "raw pts",
        });

        _dailyPnl += pnl;
        _dailyTradeCount++;
        if (exitReason.includes("SL hit")) {
          _slPauseUntilTs = candle.time + (SCALP_PAUSE_CANDLES * SCALP_RES * 60);
        }
        position = null;
      }
      continue; // skip entry eval when in position
    }

    // ── ENTRY LOGIC ─────────────────────────────────────────────────────────
    if (isEOD) continue;
    if (_dailyTradeCount >= SCALP_MAX_TRADES) continue;
    if (_dailyPnl <= -SCALP_MAX_LOSS) continue;
    if (candle.time < _slPauseUntilTs) continue;
    if (!prevDayOHLC) continue;

    // VIX check
    if (vixFilter.VIX_ENABLED) {
      const vixCheck = vixFilter.checkBacktestVix(lookupVix, candleDate, "SCALP");
      if (vixCheck && vixCheck.blocked) continue;
    }

    const result = scalpStrategy.getSignal(window, {
      silent: true,
      prevDayOHLC: prevDayOHLC,
      prevPrevDayOHLC: prevPrevDayOHLC,
    });
    if (result.signal === "NONE") continue;

    const side = result.signal === "BUY_CE" ? "CE" : "PE";

    position = {
      side,
      entryPrice:     candle.close,
      entryTs:        candle.time,
      stopLoss:       result.stopLoss,
      initialStopLoss: result.stopLoss,
      target:         null,  // no fixed target — PSAR trail only
      candlesHeld:    0,
      bestPrice:      null,
    };
  }

  // Summary
  const totalPnl  = trades.reduce((s, t) => s + t.pnl, 0);
  const wins       = trades.filter(t => t.pnl > 0);
  const losses     = trades.filter(t => t.pnl <= 0);
  const winRate    = trades.length > 0 ? ((wins.length / trades.length) * 100).toFixed(1) : "0.0";
  const avgWin     = wins.length > 0 ? (wins.reduce((s, t) => s + t.pnl, 0) / wins.length).toFixed(2) : 0;
  const avgLoss    = losses.length > 0 ? (losses.reduce((s, t) => s + t.pnl, 0) / losses.length).toFixed(2) : 0;
  const maxProfit  = trades.length > 0 ? Math.max(...trades.map(t => t.pnl)) : 0;
  const totalDrawdown = losses.reduce((s, t) => s + t.pnl, 0);
  const riskReward = (parseFloat(avgWin) && parseFloat(avgLoss))
    ? "1:" + Math.abs(parseFloat(avgWin) / parseFloat(avgLoss)).toFixed(2)
    : "\u2014";
  const maxDrawdown = (() => {
    let peak = 0, dd = 0, maxDD = 0;
    trades.forEach(t => { peak = Math.max(peak, peak + t.pnl); dd = peak - (peak + t.pnl); maxDD = Math.max(maxDD, dd); });
    return maxDD;
  })();

  const summary = {
    totalTrades: trades.length,
    wins:        wins.length,
    losses:      losses.length,
    winRate:     parseFloat(winRate),
    totalPnl:    parseFloat(totalPnl.toFixed(2)),
    avgWin:      parseFloat(avgWin),
    avgLoss:     parseFloat(avgLoss),
    maxProfit:   parseFloat(parseFloat(maxProfit).toFixed(2)),
    totalDrawdown: parseFloat(parseFloat(totalDrawdown).toFixed(2)),
    riskReward,
    maxDrawdown: parseFloat(maxDrawdown.toFixed(2)),
    optionSim:   OPTION_SIM,
    delta:       DELTA,
    thetaPerDay: THETA_DAY,
    finalCapital: parseFloat((capital + totalPnl).toFixed(2)),
    vixEnabled:  vixFilter.VIX_ENABLED,
  };

  console.log(`\n📊 SCALP BACKTEST RESULT: ${trades.length} trades | WR ${winRate}% | PnL ${inr(totalPnl)}`);

  return { summary, trades };
}

// ── Error page helper ─────────────────────────────────────────────────────────
function errorPage(title, message) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${title} — Scalp Backtest</title>
<style>*{box-sizing:border-box;margin:0;padding:0;}body{font-family:'IBM Plex Mono',monospace;background:#060810;color:#a0b8d8;min-height:100vh;display:flex;align-items:center;justify-content:center;}
.box{background:#0d1320;border:1px solid #7f1d1d;border-radius:14px;padding:40px;max-width:480px;text-align:center;}
h2{color:#ef4444;margin-bottom:12px;font-size:1.1rem;}p{font-size:0.85rem;color:#8899aa;line-height:1.6;}</style>
</head><body><div class="box"><h2>${title}</h2><p>${message}</p><br><a href="/" style="color:#3b82f6;">← Back</a></div></body></html>`;
}

// ── Route ─────────────────────────────────────────────────────────────────────
router.get("/", async (req, res) => {
  const liveActive = sharedSocketState.getMode() === "LIVE_TRADE";
  const from       = req.query.from       || process.env.BACKTEST_FROM || "2026-01-01";
  const to         = req.query.to         || process.env.BACKTEST_TO   || "2026-03-28";
  const resolution = req.query.resolution || process.env.SCALP_RESOLUTION || "3";
  const capital    = parseInt(process.env.BACKTEST_CAPITAL || "100000", 10);
  const symbol     = "NSE:NIFTY50-INDEX";

  if (liveActive) {
    res.setHeader("Content-Type", "text/html");
    return res.status(503).send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/>
      <meta name="viewport" content="width=device-width,initial-scale=1"/>
      <title>Scalp Backtest blocked — Live trade active</title>
      <style>*{box-sizing:border-box;margin:0;padding:0;}body{font-family:'IBM Plex Mono',monospace;background:#060810;color:#a0b8d8;min-height:100vh;display:flex;flex-direction:column;}
      ${sidebarCSS()}
      ${modalCSS()}
      </style>
      </head><body>
<div class="app-shell">
${buildSidebar('scalpBacktest', true)}
<div class="main-content">
      <div style="display:flex;align-items:center;justify-content:center;flex:1;padding:40px;">
        <div style="background:#0d1320;border:1px solid #7f1d1d;border-radius:14px;padding:40px 48px;max-width:480px;text-align:center;">
          <div style="font-size:2.5rem;margin-bottom:16px;">🔒</div>
          <h2 style="color:#ef4444;margin-bottom:12px;font-size:1.1rem;">Scalp Backtest blocked</h2>
          <p style="font-size:0.85rem;color:#8899aa;margin-bottom:24px;line-height:1.6;">
            Live trading is currently active. Backtest is disabled to prevent Fyers API contention and log pollution during a live session.<br><br>
            Stop the live trade first, then run your backtest.
          </p>
          <a href="/trade/status" style="background:#ef4444;color:#fff;padding:9px 22px;border-radius:8px;text-decoration:none;font-weight:600;font-size:0.85rem;">→ Go to Live Trade</a>
        </div>
      </div>
      </div></div>
<script>
${modalJS()}
</script>
</body></html>`);
  }

  if (!process.env.ACCESS_TOKEN) {
    return res.status(401).send(errorPage("Not Authenticated", "Login with Fyers first."));
  }

  console.log(`\n🔍 Scalp Backtest: ${from} to ${to} | ${resolution}m`);

  try {
    const [candles, vixCandles] = await Promise.all([
      fetchCandles(symbol, resolution, from, to),
      vixFilter.VIX_ENABLED
        ? fetchCandles(VIX_SYMBOL, "D", from, to).catch(() => [])
        : Promise.resolve([]),
    ]);

    if (candles.length < 15) {
      return res.status(400).send(errorPage("Not Enough Data", "Too few candles. Try a wider date range."));
    }

    const result = runScalpBacktest(candles, capital, vixCandles);
    saveResult("SCALP_BACKTEST", { ...result, params: { from, to, resolution, symbol, capital } });

    const s = result.summary;
    const trades = [...(result.trades || [])].reverse();

    // Build trades array - embedded safely via JSON script tag
    const tradesData = trades.map(t => ({
      side:      t.side || "",
      entry:     t.entryTime  || "",
      exit:      t.exitTime   || "",
      entryTs:   typeof t.entryTs === "number" ? t.entryTs : 0,
      exitTs:    typeof t.exitTs  === "number" ? t.exitTs  : 0,
      ePrice:    typeof t.entryPrice === "number" ? t.entryPrice : 0,
      xPrice:    typeof t.exitPrice  === "number" ? t.exitPrice  : 0,
      sl:        (t.stopLoss && t.stopLoss !== "N/A") ? parseFloat(t.stopLoss) : null,
      initialSL: (t.initialStopLoss && t.initialStopLoss !== "N/A") ? parseFloat(t.initialStopLoss) : ((t.stopLoss && t.stopLoss !== "N/A") ? parseFloat(t.stopLoss) : null),
      pnl:       typeof t.pnl === "number" ? t.pnl : null,
      spotPts:   typeof t.spotPnlPts === "number" ? t.spotPnlPts : null,
      pnlMode:   t.pnlMode || null,
      held:      typeof t.candlesHeld === "number" ? t.candlesHeld : null,
      reason:    String(t.exitReason || ""),
      risk_pts:  (() => {
        const sl = (t.initialStopLoss && t.initialStopLoss !== "N/A") ? parseFloat(t.initialStopLoss)
                 : (t.stopLoss && t.stopLoss !== "N/A") ? parseFloat(t.stopLoss) : null;
        if (!sl) return null;
        return parseFloat(Math.abs(t.entryPrice - sl).toFixed(2));
      })(),
      rr:        (() => {
        if (typeof t.pnl !== "number") return null;
        const sl = (t.initialStopLoss && t.initialStopLoss !== "N/A") ? parseFloat(t.initialStopLoss)
                 : (t.stopLoss && t.stopLoss !== "N/A") ? parseFloat(t.stopLoss) : null;
        if (!sl) return null;
        const risk   = Math.abs(t.entryPrice - sl);
        const reward = Math.abs(t.pnl);
        if (risk === 0) return null;
        const ratio = reward / risk;
        return (t.pnl >= 0 ? "1:" : "-1:") + ratio.toFixed(2);
      })(),
    }));
    // Escape </script> in JSON to prevent early tag termination
    const tradesJSON = JSON.stringify(tradesData).replace(/<\/script>/gi, "<\\/script>");

    res.setHeader("Content-Type", "text/html");
    return res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>\u26a1</text></svg>">
  <title>Scalp Backtest — ${scalpStrategy.NAME}</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0;}
    body{font-family:'IBM Plex Mono',monospace;background:#060810;color:#a0b8d8;min-height:100vh;}
    @keyframes ltpulse{0%,100%{opacity:1}50%{opacity:.25}}
    .page{padding:16px 20px 40px;}

    .stat-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:10px;margin-bottom:16px;}
    @media(max-width:900px){.stat-grid{grid-template-columns:repeat(3,1fr);}}
    @media(max-width:640px){
      .stat-grid{grid-template-columns:1fr 1fr;}
      .sc-val{font-size:0.95rem;}
      .form-section{flex-direction:column;}
      #tbl-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch;}
      .sc{padding:10px 12px;}
      .top-bar{padding:7px 10px 7px 48px;}
      .top-bar-meta{display:none;}
    }
    .sc{background:#08091a;border:0.5px solid #0e1428;border-radius:7px;padding:12px 14px;position:relative;overflow:hidden;}
    .sc::before{content:'';position:absolute;top:0;left:0;right:0;height:2px;}
    .sc.blue::before{background:#3b82f6;}.sc.green::before{background:#10b981;}.sc.red::before{background:#ef4444;}.sc.yellow::before{background:#f59e0b;}.sc.purple::before{background:#8b5cf6;}
    .sc-label{font-size:0.56rem;text-transform:uppercase;letter-spacing:1.2px;color:#1e3050;margin-bottom:5px;font-family:"IBM Plex Mono",monospace;}
    .sc-val{font-size:1.05rem;font-weight:700;color:#a0b8d8;font-family:"IBM Plex Mono",monospace;line-height:1.2;}
    .sc-sub{font-size:0.6rem;color:#4a6080;margin-top:3px;}

    .run-bar{display:flex;align-items:flex-end;gap:10px;background:#08091a;border:0.5px solid #0e1428;border-radius:8px;padding:11px 14px;margin-bottom:14px;flex-wrap:wrap;}
    .run-bar label{font-size:0.58rem;text-transform:uppercase;letter-spacing:1px;color:#4a6080;display:block;margin-bottom:3px;}
    .run-bar input,.run-bar select{background:#fff;border:1px solid #1e3a8a;color:#0f172a;padding:5px 8px;border-radius:5px;font-size:0.75rem;font-family:'IBM Plex Mono',monospace;cursor:pointer;color-scheme:light;}
    .run-btn{background:#1a3a8a;color:#90c0ff;border:1px solid #2a5ac0;padding:6px 14px;border-radius:5px;font-size:0.7rem;font-weight:700;cursor:pointer;font-family:'IBM Plex Mono',monospace;white-space:nowrap;}
    .run-btn:hover{background:#2563eb;}

    .tbar{display:flex;align-items:center;gap:8px;margin-bottom:10px;flex-wrap:wrap;}
    .tbar input,.tbar select{background:#0d1320;border:1px solid #1a2236;color:#c8d8f0;padding:5px 9px;border-radius:6px;font-size:0.76rem;font-family:inherit;}
    .tbar input:focus,.tbar select:focus{outline:none;border-color:#3b82f6;}
    .tbar-label{color:#4a6080;font-size:0.7rem;font-weight:600;text-transform:uppercase;letter-spacing:1px;}
    .tbar-count{color:#4a6080;font-size:0.7rem;}

    .tw{border:0.5px solid #0e1428;border-radius:8px;overflow:hidden;margin-bottom:10px;}
    table{width:100%;border-collapse:collapse;}
    thead th{background:#04060e;padding:7px 10px;text-align:left;font-size:0.58rem;text-transform:uppercase;letter-spacing:0.8px;color:#1e3050;cursor:pointer;user-select:none;white-space:nowrap;font-family:"IBM Plex Mono",monospace;}
    thead th:hover{color:#c8d8f0;}
    thead th.sorted{color:#3b82f6;}
    tbody tr{border-top:0.5px solid #080e1a;}
    tbody tr:hover{background:#060c1a;}
    tbody td{padding:6px 10px;font-size:0.72rem;font-family:'IBM Plex Mono',monospace;color:#4a6080;}

    .pag{display:flex;align-items:center;gap:5px;flex-wrap:wrap;}
    .pag button{background:#0d1320;border:1px solid #1a2236;color:#c8d8f0;padding:4px 9px;border-radius:5px;font-size:0.72rem;cursor:pointer;font-family:inherit;}
    .pag button:hover{border-color:#3b82f6;color:#3b82f6;}
    .pag button.active{background:#0a1e3d;border-color:#3b82f6;color:#3b82f6;font-weight:700;}
    .pag button:disabled{opacity:.3;cursor:default;}
    .pag-info{font-size:0.7rem;color:#4a6080;padding:0 4px;}

    #tooltip{position:fixed;z-index:9999;background:#1e293b;color:#e2e8f0;border:1px solid #3b82f6;border-radius:7px;padding:8px 12px;font-size:0.72rem;max-width:340px;word-break:break-word;box-shadow:0 8px 24px rgba(0,0,0,.7);pointer-events:none;display:none;line-height:1.5;font-family:sans-serif;}
    ${sidebarCSS()}
    ${modalCSS()}
  </style>
</head>
<body>
<div class="app-shell">
${buildSidebar('scalpBacktest', liveActive)}
<div class="main-content">

<div class="page">
  <!-- Context breadcrumb bar -->
  <div style="background:#06090e;border-bottom:0.5px solid #0e1428;padding:6px 20px;display:flex;align-items:center;gap:7px;margin:-16px -20px 14px;position:sticky;top:44px;z-index:90;">
    <span style="font-size:0.6rem;font-weight:700;padding:2px 8px;border-radius:3px;background:rgba(245,158,11,0.12);color:#fbbf24;border:0.5px solid rgba(245,158,11,0.25);text-transform:uppercase;letter-spacing:0.5px;font-family:'IBM Plex Mono',monospace;">SCALP BACKTEST</span>
    <span style="color:#1e2a40;font-size:10px;">\u203a</span>
    <span style="font-size:0.6rem;font-weight:700;padding:2px 8px;border-radius:3px;background:rgba(16,185,129,0.1);color:#34d399;border:0.5px solid rgba(16,185,129,0.2);text-transform:uppercase;font-family:'IBM Plex Mono',monospace;">${scalpStrategy.NAME}</span>
    <span style="color:#1e2a40;font-size:10px;">\u203a</span>
    <span style="font-size:0.6rem;font-weight:700;padding:2px 8px;border-radius:3px;background:rgba(245,158,11,0.1);color:#fbbf24;border:0.5px solid rgba(245,158,11,0.2);font-family:'IBM Plex Mono',monospace;">${from} \u2192 ${to}</span>
    <span style="margin-left:auto;font-size:0.6rem;color:#1e2a40;font-family:'IBM Plex Mono',monospace;">${resolution}-min \u00b7 ${candles.length.toLocaleString()} candles \u00b7 \u20b9${capital.toLocaleString("en-IN")}</span>
  </div>

  <!-- Run Again -->
  <div class="run-bar">
    <div><label>From</label><input type="date" id="f" value="${from}"/></div>
    <div><label>To</label><input type="date" id="t" value="${to}"/></div>
    <div><label>Candle</label>
      <select id="r">
        <option value="1" ${resolution==="1"?"selected":""}>1-min</option>
        <option value="3" ${resolution==="3"?"selected":""}>3-min</option>
        <option value="5" ${resolution==="5"?"selected":""}>5-min</option>
      </select>
    </div>
    <button class="run-btn" onclick="(function(){var f=document.getElementById('f').value,t=document.getElementById('t').value,r=document.getElementById('r').value;if(!f||!t){showAlert({icon:'\u26a0\ufe0f',title:'Missing Dates',message:'Set both From and To dates'});return;}window.location='/scalp-backtest?from='+f+'&to='+t+'&resolution='+r;})()">🔄 Run Again</button>
    <span style="font-size:0.7rem;color:#4a6080;margin-left:auto;">Strategy: <strong style="color:#f59e0b;">${scalpStrategy.NAME}</strong></span>
  </div>

  <!-- Summary -->
  <div class="stat-grid">
    <div class="sc blue"><div class="sc-label">Total Trades</div><div class="sc-val">${s.totalTrades}</div><div class="sc-sub">${s.wins}W \u00b7 ${s.losses}L</div></div>
    <div class="sc green"><div class="sc-label">Max Profit</div><div class="sc-val" style="color:#10b981;">${fmtPnl(s.maxProfit, s)}</div><div class="sc-sub">Best single trade</div></div>
    <div class="sc ${(s.totalPnl||0)>=0?"green":"red"}"><div class="sc-label">Total PnL</div><div class="sc-val" style="color:${pnlColor(s.totalPnl)};">${fmtPnl(s.totalPnl, s)}</div><div class="sc-sub">${s.optionSim ? `Option sim: \u03b4=${s.delta} \u03b8=\u20b9${s.thetaPerDay}/day` : "Raw NIFTY index pts"}</div></div>
    <div class="sc red"><div class="sc-label">Max Drawdown</div><div class="sc-val" style="color:#ef4444;">${fmtPnl(s.maxDrawdown, s)}</div><div class="sc-sub">Worst peak-to-trough</div></div>
    <div class="sc red"><div class="sc-label">Total Drawdown</div><div class="sc-val" style="color:#ef4444;">${fmtPnl(s.totalDrawdown, s)}</div><div class="sc-sub">Sum of all losses</div></div>
    <div class="sc purple"><div class="sc-label">Risk/Reward</div><div class="sc-val">${s.riskReward||"\u2014"}</div><div class="sc-sub">1 : avg win \u00f7 avg loss</div></div>
    <div class="sc yellow"><div class="sc-label">Win Rate</div><div class="sc-val">${s.winRate||"\u2014"}%</div><div class="sc-sub">${s.wins} wins of ${s.totalTrades}</div></div>
  </div>

  <!-- Filter bar -->
  <div class="tbar">
    <span class="tbar-label">Trade Log</span>
    <input id="fSearch" placeholder="Search reason\u2026" oninput="doFilter()" style="width:150px;"/>
    <select id="fSide" onchange="doFilter()">
      <option value="">All Sides</option>
      <option value="CE">CE only</option>
      <option value="PE">PE only</option>
    </select>
    <select id="fResult" onchange="doFilter()">
      <option value="">All Results</option>
      <option value="win">Wins only</option>
      <option value="loss">Losses only</option>
    </select>
    <select id="fPP" onchange="doFilter()">
      <option value="5">5/page</option>
      <option value="10" selected>10/page</option>
      <option value="25">25/page</option>
      <option value="9999">All</option>
    </select>
    <span class="tbar-count" id="cntLabel"></span>
    <button onclick="doReset()" style="margin-left:auto;background:#0d1320;border:1px solid #1a2236;color:#4a6080;padding:4px 10px;border-radius:6px;font-size:0.7rem;cursor:pointer;font-family:inherit;">Reset</button>
  </div>

  <!-- Table -->
  <div class="tw">
    <table>
      <thead><tr>
        <th onclick="doSort('side')"   id="h-side">Side &#9660;</th>
        <th onclick="doSort('entry')"  id="h-entry" class="sorted">Entry Time &#9660;</th>
        <th onclick="doSort('exit')"   id="h-exit">Exit Time</th>
        <th onclick="doSort('ePrice')" id="h-ePrice">Entry (pts)</th>
        <th onclick="doSort('xPrice')" id="h-xPrice">Exit (pts)</th>
        <th onclick="doSort('sl')"     id="h-sl">SL (pts)</th>
        <th onclick="doSort('pnl')"    id="h-pnl">PnL ${s.optionSim ? "(\u20b9 sim)" : "(pts)"}</th>
        <th onclick="doSort('risk_pts')" id="h-risk">Risk (pts)</th>
        <th onclick="doSort('rr')"     id="h-rr">R:R</th>
        <th>Exit Reason</th>
        <th style="text-align:center;">Details</th>
      </tr></thead>
      <tbody id="tbody"></tbody>
    </table>
  </div>
  <div class="pag" id="pagBar"></div>
  <div id="tooltip"></div>

  <!-- Trade Detail Modal -->
  <div id="btModal" style="display:none;position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,0.8);backdrop-filter:blur(3px);align-items:center;justify-content:center;padding:16px;">
    <div style="background:#0d1320;border:1px solid #1d3b6e;border-radius:16px;padding:24px 28px;max-width:680px;width:100%;max-height:90vh;overflow-y:auto;box-shadow:0 24px 80px rgba(0,0,0,0.9);position:relative;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:18px;">
        <div>
          <span id="btm-badge" style="font-size:0.62rem;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;padding:4px 10px;border-radius:6px;"></span>
          <span style="font-size:0.65rem;color:#4a6080;margin-left:10px;">\u26a1 Scalp Backtest — Full Details</span>
        </div>
        <button onclick="document.getElementById('btModal').style.display='none';" style="background:none;border:1px solid #1a2236;color:#4a6080;font-size:1rem;cursor:pointer;padding:4px 10px;border-radius:6px;font-family:inherit;" onmouseover="this.style.color='#ef4444';this.style.borderColor='#ef4444'" onmouseout="this.style.color='#4a6080';this.style.borderColor='#1a2236'">\u2715 Close</button>
      </div>
      <div id="btm-grid"></div>
      <div id="btm-reason" style="display:none;"></div>
    </div>
  </div>

<script id="trades-data" type="application/json">${tradesJSON}</script>
<script>
${modalJS()}
var TRADES = JSON.parse(document.getElementById('trades-data').textContent);
var filtered = TRADES.slice();
var sortCol = 'entry', sortDir = -1, pg = 1, pp = 10;

function fmt(n){ return n!=null ? Number(n).toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2}) : '\u2014'; }
var OPT_SIM = ${s.optionSim ? "true" : "false"};
function fpts(n, spotPts){
  if(n==null) return '\u2014';
  if(OPT_SIM){
    var r = (n>=0?'+':'')+'\u20b9'+Math.abs(n).toLocaleString('en-IN',{maximumFractionDigits:0});
    if(spotPts!=null) r += '<span style="font-size:0.65rem;color:#4a6080;margin-left:4px;">('+( spotPts>=0?'+':'')+spotPts.toFixed(1)+'pt)</span>';
    return r;
  }
  return (n>=0?'+':'')+n.toFixed(2)+' pts';
}

function doFilter(){
  var s=document.getElementById('fSearch').value.toLowerCase();
  var side=document.getElementById('fSide').value;
  var res=document.getElementById('fResult').value;
  pp=parseInt(document.getElementById('fPP').value);
  pg=1;
  filtered=TRADES.filter(function(t){
    if(side && t.side!==side) return false;
    if(res==='win'  && (t.pnl==null||t.pnl<0)) return false;
    if(res==='loss' && (t.pnl==null||t.pnl>=0)) return false;
    if(s && t.reason.toLowerCase().indexOf(s)<0) return false;
    return true;
  });
  doSort2();
}

function doSort(col){
  if(sortCol===col){ sortDir*=-1; } else { sortCol=col; sortDir=-1; }
  document.querySelectorAll('thead th').forEach(function(th){
    th.classList.remove('sorted');
    th.innerHTML = th.innerHTML.replace(/ [\u25bc\u25b2]$/, '');
  });
  var h=document.getElementById('h-'+col);
  if(h){ h.classList.add('sorted'); h.innerHTML = h.innerHTML.replace(/ [\u25bc\u25b2]$/, '') + (sortDir===-1?' \u25bc':' \u25b2'); }
  doSort2();
}

function doSort2(){
  var sortKey = sortCol === 'entry' ? 'entryTs' : sortCol === 'exit' ? 'exitTs' : sortCol;
  filtered.sort(function(a,b){
    var av=a[sortKey], bv=b[sortKey];
    if(av==null) av=sortDir===-1?-1e18:1e18;
    if(bv==null) bv=sortDir===-1?-1e18:1e18;
    if(typeof av==='string') return av<bv?-sortDir:av>bv?sortDir:0;
    return (av-bv)*sortDir;
  });
  render();
}

function render(){
  var start=(pg-1)*pp, slice=filtered.slice(start,start+pp);
  var tbody=document.getElementById('tbody');
  document.getElementById('cntLabel').textContent=filtered.length+' of '+TRADES.length+' trades';
  if(slice.length===0){
    tbody.innerHTML='<tr><td colspan="11" style="text-align:center;padding:20px;color:#4a6080;">No trades match filters.</td></tr>';
    document.getElementById('pagBar').innerHTML='';
    return;
  }
  window._btSlice = slice;
  var rows='';
  for(var i=0;i<slice.length;i++){
    var t=slice[i];
    var sc=t.side==='CE'?'#10b981':'#ef4444';
    var pc=t.pnl==null?'#c8d8f0':t.pnl>=0?'#10b981':'#ef4444';
    var rrc=t.rr==null?'#4a6080':t.pnl>=0?'#10b981':'#ef4444';
    var sr=t.reason.length>30?t.reason.substring(0,30)+'\u2026':t.reason;
    rows+='<tr>'
      +'<td style="color:'+sc+';font-weight:700;">'+t.side+'</td>'
      +'<td>'+t.entry+'</td>'
      +'<td>'+t.exit+'</td>'
      +'<td>'+fmt(t.ePrice)+'</td>'
      +'<td>'+fmt(t.xPrice)+'</td>'
      +'<td style="color:#f59e0b;">'+(t.sl!=null?fmt(t.sl):'\u2014')+'</td>'
      +'<td style="color:'+pc+';font-weight:700;">'+fpts(t.pnl, t.spotPts)+'</td>'
      +'<td style="color:#94a3b8;font-family:monospace;font-size:0.72rem;">'+(t.risk_pts!=null?'\u00b1'+t.risk_pts.toFixed(2)+' pts':'\u2014')+'</td>'
      +'<td style="color:'+rrc+';font-weight:700;font-family:monospace;">'+(t.rr||'\u2014')+'</td>'
      +'<td style="font-size:0.7rem;color:#4a6080;cursor:default;" data-reason="'+t.reason.replace(/"/g,'&quot;')+'">'+sr+'</td>'
      +'<td style="text-align:center;padding:6px 8px;"><button data-idx="'+i+'" class="bt-eye-btn" style="background:none;border:1px solid #1a2236;border-radius:6px;cursor:pointer;padding:4px 8px;color:#4a9cf5;font-size:0.85rem;" title="View full details">\ud83d\udc41</button></td>'
      +'</tr>';
  }
  tbody.innerHTML=rows;

  Array.from(tbody.querySelectorAll('.bt-eye-btn')).forEach(function(btn){
    btn.addEventListener('click',function(){ showBTModal(window._btSlice[parseInt(this.getAttribute('data-idx'))]); });
    btn.addEventListener('mouseover',function(){ this.style.borderColor='#3b82f6';this.style.background='#0a1e3d'; });
    btn.addEventListener('mouseout', function(){ this.style.borderColor='#1a2236';this.style.background='none'; });
  });

  Array.from(tbody.querySelectorAll('td[data-reason]')).forEach(function(td){
    td.addEventListener('mouseenter',function(e){
      var tip=document.getElementById('tooltip');
      tip.textContent=td.getAttribute('data-reason');
      tip.style.display='block';
      moveTip(e);
    });
    td.addEventListener('mouseleave',function(){ document.getElementById('tooltip').style.display='none'; });
    td.addEventListener('mousemove',moveTip);
  });

  renderPag();
}

function moveTip(e){
  var tip=document.getElementById('tooltip');
  var x=e.clientX+14, y=e.clientY+14;
  if(x+360>window.innerWidth) x=e.clientX-360;
  if(y+80>window.innerHeight) y=e.clientY-60;
  tip.style.left=x+'px'; tip.style.top=y+'px';
}

function renderPag(){
  var total=Math.ceil(filtered.length/pp);
  var bar=document.getElementById('pagBar');
  if(total<=1){ bar.innerHTML=''; return; }
  var h='<button onclick="goPg('+(pg-1)+')" '+(pg===1?'disabled':'')+'>\\u2190 Prev</button>';
  h+='<span class="pag-info">Page '+pg+' of '+total+'</span>';
  var s=Math.max(1,pg-2), e=Math.min(total,pg+2);
  for(var p=s;p<=e;p++) h+='<button onclick="goPg('+p+')" class="'+(p===pg?'active':'')+'">'+p+'</button>';
  h+='<button onclick="goPg('+(pg+1)+')" '+(pg===total?'disabled':'')+'>Next \\u2192</button>';
  bar.innerHTML=h;
}

function goPg(p){
  var total=Math.ceil(filtered.length/pp);
  pg=Math.max(1,Math.min(total,p));
  render();
  window.scrollTo({top:0,behavior:'smooth'});
}

function doReset(){
  document.getElementById('fSearch').value='';
  document.getElementById('fSide').value='';
  document.getElementById('fResult').value='';
  document.getElementById('fPP').value='10';
  document.querySelectorAll('thead th').forEach(function(th){ th.classList.remove('sorted'); });
  var h=document.getElementById('h-entry');
  if(h) h.classList.add('sorted');
  sortCol='entry'; sortDir=-1; pp=10; pg=1;
  filtered=TRADES.slice();
  doSort2();
}

// Init
doFilter();

function showBTModal(t){
  var pc=t.pnl==null?'#c8d8f0':t.pnl>=0?'#10b981':'#ef4444';
  var sc=t.side==='CE'?'#10b981':'#ef4444';
  var pnlPts=(t.ePrice&&t.xPrice&&t.side)?parseFloat(((t.side==='PE'?t.ePrice-t.xPrice:t.xPrice-t.ePrice)).toFixed(2)):null;
  var badge=document.getElementById('btm-badge');
  badge.textContent=(t.side||'\u2014');
  badge.style.background=t.side==='CE'?'rgba(16,185,129,0.15)':'rgba(239,68,68,0.15)';
  badge.style.color=sc;
  badge.style.border='1px solid '+(t.side==='CE'?'rgba(16,185,129,0.3)':'rgba(239,68,68,0.3)');

  function cell(label,val,color,sub){
    return '<div style="background:#060910;border:1px solid #1a2236;border-radius:8px;padding:11px 13px;">'
      +'<div style="font-size:0.52rem;text-transform:uppercase;letter-spacing:1.2px;color:#3a5070;margin-bottom:5px;">'+label+'</div>'
      +'<div style="font-size:0.9rem;font-weight:700;color:'+(color||'#e0eaf8')+';font-family:monospace;line-height:1.3;">'+(val||'\u2014')+'</div>'
      +(sub?'<div style="font-size:0.62rem;color:#4a6080;margin-top:3px;">'+sub+'</div>':'')
      +'</div>';
  }

  var entryHtml='<div style="background:#060c18;border:1px solid #0d2040;border-radius:10px;padding:12px 14px;margin-bottom:10px;">'
    +'<div style="font-size:0.55rem;text-transform:uppercase;letter-spacing:1.5px;color:#1a4080;margin-bottom:8px;font-weight:700;">\ud83d\udfe2 Entry</div>'
    +'<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;">'
    +cell('Entry Time',     t.entry||'\u2014',   '#c8d8f0')
    +cell('NIFTY Spot @ Entry', fmt(t.ePrice), '#fff', 'Spot price at signal')
    +cell('Stop Loss',      t.sl!=null?fmt(t.sl):'\u2014', '#f59e0b', 'NIFTY spot SL level')
    +cell('Risk (pts)',     t.risk_pts!=null?'\u00b1'+t.risk_pts.toFixed(2)+' pts':'\u2014', '#94a3b8', 'Entry to SL distance')
    +'</div></div>';

  var exitHtml='<div style="background:#0c0608;border:1px solid #3a0d12;border-radius:10px;padding:12px 14px;margin-bottom:10px;">'
    +'<div style="font-size:0.55rem;text-transform:uppercase;letter-spacing:1.5px;color:#801a20;margin-bottom:8px;font-weight:700;">\ud83d\udd34 Exit</div>'
    +'<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;">'
    +cell('Exit Time',      t.exit||'\u2014',    '#c8d8f0')
    +cell('NIFTY Spot @ Exit', fmt(t.xPrice), '#fff', 'Spot price at exit')
    +cell('NIFTY Move (pts)', pnlPts!=null?(pnlPts>=0?'+':'')+pnlPts+' pts':'\u2014', pnlPts!=null?(pnlPts>=0?'#10b981':'#ef4444'):'#c8d8f0', t.side==='PE'?'Entry\u2212Exit (PE profits on fall)':'Exit\u2212Entry (CE profits on rise)')
    +cell('PnL',           t.pnl!=null?(t.pnl>=0?'+':'')+( OPT_SIM ? '\u20b9'+Math.abs(t.pnl).toLocaleString('en-IN',{maximumFractionDigits:0}) : t.pnl.toFixed(2)+' pts' ):'\u2014', pc, OPT_SIM ? 'Option sim: spot\u00d7\u03b4\u2212\u03b8\u2212brok (see pnlMode)' : 'Raw NIFTY index pts')
    +cell('Spot PnL (pts)',t.spotPts!=null?(t.spotPts>=0?'+':'')+t.spotPts.toFixed(2)+' pts':'\u2014', t.spotPts!=null?(t.spotPts>=0?'#10b981':'#ef4444'):'#4a6080', 'Raw NIFTY index point move')
    +cell('Held (candles)',t.held!=null?t.held+' candles':'\u2014', '#94a3b8', 'Candles held \u2014 affects theta decay')
    +cell('PnL Method',   t.pnlMode||'\u2014', '#4a6080', 'How PnL was calculated')
    +cell('R:R Ratio',     t.rr||'\u2014', t.pnl!=null&&t.pnl>=0?'#10b981':'#ef4444', 'Reward \u00f7 Risk')
    +'</div></div>';

  var reasonHtml='<div style="background:#060910;border:1px solid #1a2236;border-radius:10px;padding:12px 14px;">'
    +'<div style="font-size:0.55rem;text-transform:uppercase;letter-spacing:1.5px;color:#3a5070;margin-bottom:6px;font-weight:700;">\ud83d\udccc Exit Reason</div>'
    +'<div style="font-size:0.82rem;color:#a0b8d0;line-height:1.6;font-family:monospace;">'+(t.reason||'\u2014')+'</div>'
    +'</div>';

  document.getElementById('btm-grid').innerHTML=entryHtml+exitHtml+reasonHtml;
  document.getElementById('btm-reason').style.display='none';
  var m=document.getElementById('btModal');
  m.style.display='flex';
}
document.getElementById('btModal').addEventListener('click',function(e){
  if(e.target===this) this.style.display='none';
});
</script>
</div></div>
</body>
</html>`);

  } catch (err) {
    console.error("Scalp backtest error:", err);
    res.status(500).send(errorPage("Backtest Failed", err.message));
  }
});

module.exports = router;

/**
 * SCALP BACKTEST — /scalp-backtest
 * ─────────────────────────────────────────────────────────────────────────────
 * Backtests the scalp strategy (EMA9 cross + RSI) on 3-min candles.
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
const scalpStrategy    = require("../strategies/scalp_ema9_rsi");
const { saveResult }   = require("../utils/resultStore");
const sharedSocketState = require("../utils/sharedSocketState");
const { buildSidebar, sidebarCSS, modalCSS, modalJS } = require("../utils/sharedNav");
const vixFilter = require("../services/vixFilter");
const { VIX_SYMBOL } = vixFilter;
const instrumentConfig = require("../config/instrument");
const { getLotQty } = instrumentConfig;

const inr = (n) => typeof n === "number" ? "\u20b9" + n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "\u2014";

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
  const CANDLES_PER_DAY = 130; // 3-min candles in 6.5h trading day

  // Scalp config
  const SCALP_SL_PTS      = parseFloat(process.env.SCALP_SL_PTS || "12");
  const SCALP_TARGET_PTS  = parseFloat(process.env.SCALP_TARGET_PTS || "18");
  const SCALP_TRAIL_GAP   = parseFloat(process.env.SCALP_TRAIL_GAP || "8");
  const SCALP_TRAIL_AFTER = parseFloat(process.env.SCALP_TRAIL_AFTER || "10");
  const SCALP_TIME_STOP   = parseInt(process.env.SCALP_TIME_STOP_CANDLES || "4", 10);
  const SCALP_MAX_TRADES  = parseInt(process.env.SCALP_MAX_DAILY_TRADES || "30", 10);
  const SCALP_MAX_LOSS    = parseFloat(process.env.SCALP_MAX_DAILY_LOSS || "2000");
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

  console.log("\n══════════════════════════════════════════════");
  console.log(`🔍 SCALP BACKTEST — ${scalpStrategy.NAME}`);
  console.log(`   Candles: ${candles.length} | SL: ${SCALP_SL_PTS}pt | TGT: ${SCALP_TARGET_PTS}pt | Trail: ${SCALP_TRAIL_GAP}pt after ${SCALP_TRAIL_AFTER}pt`);
  console.log(`   TimeStop: ${SCALP_TIME_STOP} candles | MaxTrades: ${SCALP_MAX_TRADES}/day | MaxLoss: ₹${SCALP_MAX_LOSS}/day`);
  console.log("══════════════════════════════════════════════");

  const window = candles.slice(0, 15);
  let _slPauseUntilTs = 0;
  let _dailyTradeCount = 0;
  let _dailyPnl = 0;
  let _prevDate = null;

  for (let i = 15; i < candles.length; i++) {
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

    // ── EXIT LOGIC ──────────────────────────────────────────────────────────
    if (position) {
      position.candlesHeld = (position.candlesHeld || 0) + 1;

      let exitReason = null;
      let exitPrice  = candle.close;

      // 1. Target hit (intra-candle simulation)
      if (position.side === "CE" && candle.high >= position.target) {
        exitPrice  = position.target;
        exitReason = `Target hit (${SCALP_TARGET_PTS}pt)`;
      } else if (position.side === "PE" && candle.low <= position.target) {
        exitPrice  = position.target;
        exitReason = `Target hit (${SCALP_TARGET_PTS}pt)`;
      }

      // 2. Stop loss hit (intra-candle)
      if (!exitReason) {
        if (position.side === "CE" && candle.low <= position.stopLoss) {
          exitPrice  = position.stopLoss;
          exitReason = `SL hit (${SCALP_SL_PTS}pt)`;
        } else if (position.side === "PE" && candle.high >= position.stopLoss) {
          exitPrice  = position.stopLoss;
          exitReason = `SL hit (${SCALP_SL_PTS}pt)`;
        }
      }

      // 3. Trailing SL
      if (!exitReason) {
        if (position.side === "CE") {
          if (candle.high > (position.bestPrice || position.entryPrice)) {
            position.bestPrice = candle.high;
          }
          const moveInFavour = (position.bestPrice || position.entryPrice) - position.entryPrice;
          if (moveInFavour >= SCALP_TRAIL_AFTER) {
            const trailSL = position.bestPrice - SCALP_TRAIL_GAP;
            if (trailSL > position.stopLoss) position.stopLoss = trailSL;
            if (candle.low <= position.stopLoss) {
              exitPrice  = position.stopLoss;
              exitReason = `Trail SL (gap=${SCALP_TRAIL_GAP}pt)`;
            }
          }
        } else {
          if (candle.low < (position.bestPrice || position.entryPrice)) {
            position.bestPrice = candle.low;
          }
          const moveInFavour = position.entryPrice - (position.bestPrice || position.entryPrice);
          if (moveInFavour >= SCALP_TRAIL_AFTER) {
            const trailSL = position.bestPrice + SCALP_TRAIL_GAP;
            if (trailSL < position.stopLoss) position.stopLoss = trailSL;
            if (candle.high >= position.stopLoss) {
              exitPrice  = position.stopLoss;
              exitReason = `Trail SL (gap=${SCALP_TRAIL_GAP}pt)`;
            }
          }
        }
      }

      // 4. RSI reversal exit
      if (!exitReason) {
        const { rsi } = scalpStrategy.getSignal(window, { silent: true });
        if (position.side === "CE" && rsi < 50) {
          exitReason = `RSI reversal (RSI=${rsi} < 50)`;
        } else if (position.side === "PE" && rsi > 50) {
          exitReason = `RSI reversal (RSI=${rsi} > 50)`;
        }
      }

      // 5. Time stop (4 candles = 12 min)
      if (!exitReason && position.candlesHeld >= SCALP_TIME_STOP) {
        exitReason = `Time stop (${SCALP_TIME_STOP} candles / ${SCALP_TIME_STOP * 3}min)`;
      }

      // 6. EOD
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
          target:       position.target,
          pnl,
          spotPnlPts:   parseFloat(spotPnlPts.toFixed(2)),
          candlesHeld:  position.candlesHeld,
          exitReason,
          pnlMode:      OPTION_SIM ? "option sim" : "raw pts",
        });

        _dailyPnl += pnl;
        _dailyTradeCount++;
        if (exitReason.includes("SL hit")) {
          _slPauseUntilTs = candle.time + (SCALP_PAUSE_CANDLES * 180);
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

    // VIX check
    if (vixFilter.VIX_ENABLED) {
      const vixCheck = vixFilter.checkBacktestVix(lookupVix, candleDate, "SCALP");
      if (vixCheck && vixCheck.blocked) continue;
    }

    const result = scalpStrategy.getSignal(window, { silent: true });
    if (result.signal === "NONE") continue;

    const side = result.signal === "BUY_CE" ? "CE" : "PE";

    position = {
      side,
      entryPrice:     candle.close,
      entryTs:        candle.time,
      stopLoss:       result.stopLoss,
      initialStopLoss: result.stopLoss,
      target:         result.target,
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
    maxDrawdown: parseFloat(maxDrawdown.toFixed(2)),
    optionSim:   OPTION_SIM,
    finalCapital: parseFloat((capital + totalPnl).toFixed(2)),
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
</head><body><div class="box"><h2>${title}</h2><p>${message}</p><br><a href="/scalp-backtest" style="color:#3b82f6;">← Back</a></div></body></html>`;
}

// ── Route ─────────────────────────────────────────────────────────────────────
router.get("/", async (req, res) => {
  const liveActive = sharedSocketState.getMode() === "LIVE_TRADE";
  const from       = req.query.from       || process.env.BACKTEST_FROM || "2026-01-01";
  const to         = req.query.to         || process.env.BACKTEST_TO   || "2026-03-28";
  const resolution = req.query.resolution || process.env.SCALP_RESOLUTION || "3";
  const capital    = parseInt(process.env.BACKTEST_CAPITAL || "100000", 10);
  const symbol     = "NSE:NIFTY50-INDEX";

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

    // Build trade rows HTML
    const tradeRows = trades.map((t, idx) => {
      const pnlColor = t.pnl >= 0 ? "#10b981" : "#ef4444";
      const sideColor = t.side === "CE" ? "#10b981" : "#ef4444";
      return `<tr>
        <td>${trades.length - idx}</td>
        <td style="color:${sideColor};font-weight:700;">${t.side}</td>
        <td>${t.entryTime}</td>
        <td>${t.exitTime}</td>
        <td>\u20b9${t.entryPrice}</td>
        <td>\u20b9${t.exitPrice}</td>
        <td style="color:${pnlColor};font-weight:700;">${t.pnl >= 0 ? "+" : ""}${s.optionSim ? "\u20b9" + t.pnl.toFixed(0) : t.spotPnlPts.toFixed(1) + "pt"}</td>
        <td>${t.candlesHeld}</td>
        <td style="font-size:0.7rem;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${t.exitReason}</td>
      </tr>`;
    }).join("");

    const pnlColor = s.totalPnl >= 0 ? "#10b981" : "#ef4444";

    res.setHeader("Content-Type", "text/html");
    res.send(`<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Scalp Backtest — ${scalpStrategy.NAME}</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>\u26a1</text></svg>">
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;600;700&family=IBM+Plex+Mono:wght@500;700&display=swap" rel="stylesheet">
<style>
${sidebarCSS()}
${modalCSS()}
*{box-sizing:border-box;margin:0;padding:0;}
body{font-family:'IBM Plex Sans',sans-serif;background:#060810;color:#c0d0e8;min-height:100vh;display:flex;flex-direction:column;}
.main-content{flex:1;padding:28px 32px;margin-left:220px;}
@media(max-width:900px){.main-content{margin-left:0;padding:16px;}}
h1{font-size:1.2rem;font-weight:700;color:#e0eaf8;margin-bottom:8px;}
.subtitle{font-size:0.75rem;color:#5a7090;margin-bottom:20px;}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:24px;}
.stat{background:#0d1320;border:1px solid #1a2236;border-radius:10px;padding:14px 16px;}
.stat-label{font-size:0.65rem;color:#4a6080;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;}
.stat-value{font-size:1.1rem;font-weight:700;font-family:'IBM Plex Mono',monospace;}
table{width:100%;border-collapse:collapse;font-size:0.75rem;font-family:'IBM Plex Mono',monospace;}
th{text-align:left;padding:8px 10px;background:#0a1020;color:#5a7090;font-weight:600;border-bottom:1px solid #1a2236;position:sticky;top:0;}
td{padding:7px 10px;border-bottom:1px solid #0d1525;color:#a0b8d0;}
tr:hover td{background:#0a1228;}
.table-wrap{max-height:60vh;overflow-y:auto;border-radius:10px;border:1px solid #1a2236;}
</style></head><body>
<div class="app-shell">
${buildSidebar('scalpBacktest', liveActive)}
<div class="main-content">
<h1>\u26a1 Scalp Backtest — ${scalpStrategy.NAME}</h1>
<div class="subtitle">${from} to ${to} | ${resolution}-min candles | ${candles.length} candles</div>

<div class="stats">
  <div class="stat"><div class="stat-label">Total PnL</div><div class="stat-value" style="color:${pnlColor}">${s.optionSim ? inr(s.totalPnl) : s.totalPnl.toFixed(1) + " pts"}</div></div>
  <div class="stat"><div class="stat-label">Trades</div><div class="stat-value">${s.totalTrades}</div></div>
  <div class="stat"><div class="stat-label">Win Rate</div><div class="stat-value">${s.winRate}%</div></div>
  <div class="stat"><div class="stat-label">Wins / Losses</div><div class="stat-value" style="color:#10b981">${s.wins}<span style="color:#5a7090"> / </span><span style="color:#ef4444">${s.losses}</span></div></div>
  <div class="stat"><div class="stat-label">Avg Win</div><div class="stat-value" style="color:#10b981">${s.optionSim ? inr(s.avgWin) : s.avgWin + " pts"}</div></div>
  <div class="stat"><div class="stat-label">Avg Loss</div><div class="stat-value" style="color:#ef4444">${s.optionSim ? inr(s.avgLoss) : s.avgLoss + " pts"}</div></div>
  <div class="stat"><div class="stat-label">Max Drawdown</div><div class="stat-value" style="color:#ef4444">${s.optionSim ? inr(s.maxDrawdown) : s.maxDrawdown.toFixed(1) + " pts"}</div></div>
  <div class="stat"><div class="stat-label">Final Capital</div><div class="stat-value">${inr(s.finalCapital)}</div></div>
</div>

<div class="table-wrap">
<table>
<thead><tr><th>#</th><th>Side</th><th>Entry</th><th>Exit</th><th>Entry \u20b9</th><th>Exit \u20b9</th><th>PnL</th><th>Candles</th><th>Exit Reason</th></tr></thead>
<tbody>${tradeRows}</tbody>
</table>
</div>
</div></div>
<script>
${modalJS()}
</script>
</body></html>`);

  } catch (err) {
    console.error("Scalp backtest error:", err);
    res.status(500).send(errorPage("Backtest Failed", err.message));
  }
});

module.exports = router;

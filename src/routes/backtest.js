const express = require("express");
const router  = express.Router();
const { fetchCandles, runBacktest } = require("../services/backtestEngine");
const { getActiveStrategy, ACTIVE } = require("../strategies");
const { saveResult } = require("../utils/resultStore");

const inr      = (n) => typeof n === "number" ? "\u20b9" + n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "\u2014";
const pnlColor = (n) => (typeof n === "number" && n >= 0) ? "#10b981" : "#ef4444";

/**
 * GET /backtest?from=2024-01-01&to=2024-06-30&resolution=5
 * Runs backtest and returns a full HTML result page (not JSON).
 * Date params come from the URL — set dynamically from the homepage date picker.
 */
router.get("/", async (req, res) => {
  const from       = req.query.from       || process.env.BACKTEST_FROM || "2024-01-01";
  const to         = req.query.to         || process.env.BACKTEST_TO   || "2024-12-31";
  const resolution = req.query.resolution || "5";
  const capital    = parseInt(process.env.BACKTEST_CAPITAL || "100000", 10);
  const symbol     = req.query.symbol     || "NSE:NIFTY50-INDEX";

  if (!process.env.ACCESS_TOKEN) {
    res.setHeader("Content-Type", "text/html");
    return res.status(401).send(errorPage("Not Authenticated",
      "You need to login first before running a backtest.",
      from, to, resolution));
  }

  // Show loading page that auto-submits, or run immediately
  console.log(`\n Backtest: ${ACTIVE} | ${from} to ${to} | ${resolution}m`);

  try {
    const strategy = getActiveStrategy();
    const candles  = await fetchCandles(symbol, resolution, from, to);

    if (candles.length < 30) {
      res.setHeader("Content-Type", "text/html");
      return res.status(400).send(errorPage("Not Enough Data",
        "Too few candles for the selected date range. Try a wider range (at least 1 month).",
        from, to, resolution));
    }

    const result = runBacktest(candles, strategy, capital);
    saveResult(ACTIVE, { ...result, params: { from, to, resolution, symbol, capital } });

    console.log(`Backtest done. Trades: ${result.summary.totalTrades}, PnL: ${result.summary.totalPnl}`);

    const s = result.summary;
    const trades = result.trades || [];

    const tradeRows = trades.map((t) => {
      const sc = t.side === "CE" ? "#10b981" : "#ef4444";
      const pc = t.pnl >= 0 ? "#10b981" : "#ef4444";
      return `<tr>
        <td style="color:${sc};font-weight:700;">${t.side}</td>
        <td>${t.entryTime || "\u2014"}</td>
        <td>${t.exitTime  || "\u2014"}</td>
        <td>${inr(t.entryPrice)}</td>
        <td>${inr(t.exitPrice)}</td>
        <td style="color:#f59e0b;">${t.stopLoss && t.stopLoss !== "N/A" ? inr(parseFloat(t.stopLoss)) : "\u2014"}</td>
        <td style="color:${pc};font-weight:700;">${inr(t.pnl)}</td>
        <td style="font-size:0.72rem;color:#4a6080;max-width:180px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${t.exitReason || "\u2014"}</td>
      </tr>`;
    }).join("");

    // Build PnL running total for mini chart
    let running = capital;
    const equity = trades.map(t => { running += t.pnl; return running.toFixed(0); });
    const eqLabels = trades.map((t, i) => `T${i+1}`);

    res.setHeader("Content-Type", "text/html");
    return res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Backtest Result — ${ACTIVE}</title>
  <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet"/>
  <style>
    *{box-sizing:border-box;margin:0;padding:0;}
    body{font-family:'Space Grotesk',sans-serif;background:#080c14;color:#c8d8f0;padding-bottom:60px;}
    nav{display:flex;align-items:center;justify-content:space-between;padding:14px 28px;border-bottom:1px solid #1a2236;background:#0d1320;position:sticky;top:0;z-index:10;flex-wrap:wrap;gap:8px;}
    nav .brand{font-size:1rem;font-weight:700;color:#fff;}nav .brand span{color:#3b82f6;}
    nav a{font-size:0.76rem;color:#4a6080;text-decoration:none;padding:5px 10px;border-radius:6px;border:1px solid transparent;}
    nav a:hover{color:#c8d8f0;border-color:#1a2236;background:#1a2236;}
    .page{max-width:1200px;margin:0 auto;padding:32px 20px;}
    .sg{display:grid;grid-template-columns:repeat(auto-fit,minmax(155px,1fr));gap:12px;margin-bottom:24px;}
    .sc{background:#0d1320;border:1px solid #1a2236;border-radius:10px;padding:18px;position:relative;overflow:hidden;}
    .sc::before{content:'';position:absolute;top:0;left:0;right:0;height:2px;}
    .sc.blue::before{background:#3b82f6;}.sc.green::before{background:#10b981;}.sc.red::before{background:#ef4444;}.sc.yellow::before{background:#f59e0b;}.sc.purple::before{background:#8b5cf6;}
    .sc-label{font-size:0.63rem;text-transform:uppercase;letter-spacing:1px;color:#4a6080;margin-bottom:8px;}
    .sc-val{font-size:1.3rem;font-weight:700;color:#fff;font-family:'JetBrains Mono',monospace;}
    .sc-sub{font-size:0.68rem;color:#4a6080;margin-top:5px;}
    .sec{font-size:0.7rem;font-weight:600;text-transform:uppercase;letter-spacing:1.2px;color:#4a6080;margin-bottom:12px;display:flex;align-items:center;gap:8px;}
    .sec::after{content:'';flex:1;height:1px;background:#1a2236;}
    .tw{border:1px solid #1a2236;border-radius:10px;overflow:hidden;margin-bottom:28px;}
    table{width:100%;border-collapse:collapse;}
    thead th{background:#080c14;padding:10px 14px;text-align:left;font-size:0.62rem;text-transform:uppercase;letter-spacing:1px;color:#4a6080;font-weight:600;}
    tbody tr{border-top:1px solid #1a2236;}tbody tr:hover{background:#0d1726;}
    tbody td{padding:10px 14px;font-size:0.8rem;font-family:'JetBrains Mono',monospace;}
    .run-again{display:flex;gap:12px;align-items:flex-end;background:#0d1320;border:1px solid #1a2236;border-radius:10px;padding:18px 24px;margin-bottom:28px;flex-wrap:wrap;}
    .run-again label{font-size:0.7rem;text-transform:uppercase;letter-spacing:1px;color:#4a6080;display:block;margin-bottom:6px;}
    .run-again input,.run-again select{background:#080c14;border:1px solid #1a2236;color:#c8d8f0;padding:8px 12px;border-radius:6px;font-size:0.85rem;font-family:'Space Grotesk',sans-serif;}
    .run-again input:focus,.run-again select:focus{outline:none;border-color:#3b82f6;}
    .run-btn{background:#3b82f6;color:#fff;border:none;padding:9px 20px;border-radius:6px;font-size:0.85rem;font-weight:600;cursor:pointer;white-space:nowrap;font-family:'Space Grotesk',sans-serif;}
    .run-btn:hover{background:#2563eb;}
  </style>
</head>
<body>
<nav>
  <div class="brand">📈 Fyers <span>Trading</span></div>
  <div style="display:flex;gap:6px;flex-wrap:wrap;">
    <a href="/">Dashboard</a>
    <a href="/backtest" style="color:#3b82f6;border-color:#1d3b6e;background:#0a1e3d;">Backtest</a>
    <a href="/result">My Result</a>
    <a href="/result/compare">Compare</a>
    <a href="/paperTrade/status">Paper Status</a>
  </div>
</nav>
<div class="page">

  <div style="margin-bottom:24px;">
    <div style="margin-bottom:8px;">
      <span style="font-size:0.68rem;font-weight:700;letter-spacing:1px;padding:3px 8px;border-radius:4px;text-transform:uppercase;background:#0a1e3d;color:#3b82f6;border:1px solid #1d3b6e;margin-right:8px;">BACKTEST</span>
      <span style="font-size:0.68rem;font-weight:700;letter-spacing:1px;padding:3px 8px;border-radius:4px;text-transform:uppercase;background:#052e16;color:#10b981;border:1px solid #065f46;margin-right:8px;">${ACTIVE}</span>
      <span style="font-size:0.68rem;font-weight:700;letter-spacing:1px;padding:3px 8px;border-radius:4px;text-transform:uppercase;background:#2d1f00;color:#f59e0b;border:1px solid #78350f;">${from} \u2192 ${to}</span>
    </div>
    <h1 style="font-size:1.4rem;font-weight:700;color:#fff;letter-spacing:-0.5px;">${s.strategy || ACTIVE} Backtest Results</h1>
    <p style="font-size:0.82rem;color:#4a6080;margin-top:4px;">${resolution}-min candles \u00b7 ${candles.length.toLocaleString()} candles \u00b7 Starting capital ₹${capital.toLocaleString("en-IN")}</p>
  </div>

  <!-- Run again form -->
  <div class="run-again">
    <div>
      <label>From Date</label>
      <input type="date" id="f" value="${from}"/>
    </div>
    <div>
      <label>To Date</label>
      <input type="date" id="t" value="${to}"/>
    </div>
    <div>
      <label>Resolution</label>
      <select id="r">
        <option value="5" ${resolution==="5"?"selected":""}>5-min</option>
        <option value="15" ${resolution==="15"?"selected":""}>15-min</option>
        <option value="60" ${resolution==="60"?"selected":""}>60-min</option>
      </select>
    </div>
    <button class="run-btn" onclick="rerun()">🔄 Run Again</button>
  </div>
  <script>function rerun(){const f=document.getElementById('f').value,t=document.getElementById('t').value,r=document.getElementById('r').value;if(!f||!t){alert('Please set both dates');return;}window.location='/backtest?from='+f+'&to='+t+'&resolution='+r;}</script>

  <!-- Summary stats -->
  <div class="sg">
    <div class="sc blue">
      <div class="sc-label">Total Trades</div>
      <div class="sc-val">${s.totalTrades}</div>
      <div class="sc-sub">${s.wins}W \u00b7 ${s.losses}L</div>
    </div>
    <div class="sc ${s.totalPnl >= 0 ? "green" : "red"}">
      <div class="sc-label">Total PnL</div>
      <div class="sc-val" style="color:${pnlColor(s.totalPnl)};">${inr(s.totalPnl)}</div>
      <div class="sc-sub">After \u20b940 brokerage/trade</div>
    </div>
    <div class="sc yellow">
      <div class="sc-label">Win Rate</div>
      <div class="sc-val">${s.winRate || "\u2014"}</div>
      <div class="sc-sub">${s.wins} wins of ${s.totalTrades}</div>
    </div>
    <div class="sc red">
      <div class="sc-label">Max Drawdown</div>
      <div class="sc-val neg" style="color:#ef4444;">${inr(s.maxDrawdown)}</div>
      <div class="sc-sub">Worst trade loss</div>
    </div>
    <div class="sc purple">
      <div class="sc-label">Risk / Reward</div>
      <div class="sc-val">${s.riskReward || "\u2014"}</div>
      <div class="sc-sub">Avg win \u00f7 avg loss</div>
    </div>
    <div class="sc ${(s.finalCapital - capital) >= 0 ? "green" : "red"}">
      <div class="sc-label">Final Capital</div>
      <div class="sc-val" style="color:${pnlColor(s.finalCapital - capital)};">${inr(s.finalCapital)}</div>
      <div class="sc-sub">Started: \u20b9${capital.toLocaleString("en-IN")}</div>
    </div>
  </div>

  <!-- Trade log -->
  <div class="sec">Trade Log (${trades.length} trades, newest last)</div>
  ${trades.length > 0 ? `<div class="tw">
    <table>
      <thead><tr>
        <th>Side</th><th>Entry Time</th><th>Exit Time</th>
        <th>Entry \u20b9</th><th>Exit \u20b9</th><th>SL \u20b9</th><th>PnL \u20b9</th><th>Exit Reason</th>
      </tr></thead>
      <tbody>${tradeRows}</tbody>
    </table>
  </div>` : `<div style="padding:24px;text-align:center;color:#4a6080;background:#0d1320;border:1px solid #1a2236;border-radius:10px;">No trades generated for this period.</div>`}

</div>
</body>
</html>`);

  } catch (err) {
    console.error("Backtest error:", err.message);
    res.setHeader("Content-Type", "text/html");
    return res.status(500).send(errorPage("Backtest Failed", err.message + " — Common causes: (1) Not logged in. (2) No Historical Data permission in Fyers MyAPI. (3) Date range too narrow.", from, to, resolution));
  }
});

function errorPage(title, msg, from, to, resolution) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"/><title>${title}</title>
  <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;600;700&display=swap" rel="stylesheet"/>
  <style>*{box-sizing:border-box;margin:0;padding:0;}body{font-family:'Space Grotesk',sans-serif;background:#080c14;color:#c8d8f0;display:flex;align-items:center;justify-content:center;min-height:100vh;}
  .box{background:#0d1320;border:1px solid #1a2236;border-radius:14px;padding:40px;max-width:500px;text-align:center;}
  h2{color:#ef4444;font-size:1.2rem;margin-bottom:12px;}p{font-size:0.85rem;color:#4a6080;margin-bottom:24px;line-height:1.6;}
  a{background:#3b82f6;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:600;font-size:0.85rem;}
  </style></head><body><div class="box"><div style="font-size:2.5rem;margin-bottom:16px;">⚠️</div>
  <h2>${title}</h2><p>${msg}</p><a href="/">Back to Dashboard</a></div></body></html>`;
}

module.exports = router;

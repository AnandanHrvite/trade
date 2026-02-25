require("dotenv").config();
const express = require("express");
const { getAllStrategies, ACTIVE } = require("./strategies");
const { INSTRUMENT } = require("./config/instrument");

const app = express();
app.use(express.json());

// ── Routes ────────────────────────────────────────────────────────────────────
app.use("/auth",       require("./routes/auth"));
app.use("/backtest",   require("./routes/backtest"));
app.use("/result",     require("./routes/result"));
app.use("/paperTrade", require("./routes/paperTrade"));
app.use("/trade",      require("./routes/trade"));

// ── Home — HTML Dashboard ─────────────────────────────────────────────────────
app.get("/", (req, res) => {
  const strategies = getAllStrategies();
  const liveEnabled = process.env.LIVE_TRADE_ENABLED === "true";

  const strategyRows = strategies.map(s => `
    <tr class="${s.active ? 'active-row' : ''}">
      <td><span class="badge ${s.active ? 'badge-active' : 'badge-inactive'}">${s.active ? '● ACTIVE' : '○'}</span></td>
      <td><strong>${s.key}</strong></td>
      <td>${s.name}</td>
      <td>${s.description}</td>
    </tr>`).join("");

  const backtestFrom = process.env.BACKTEST_FROM || "2024-01-01";
  const backtestTo   = process.env.BACKTEST_TO   || "2024-12-31";

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Fyers Trading App</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #0f1117;
      color: #e2e8f0;
      min-height: 100vh;
    }
    header {
      background: linear-gradient(135deg, #1a1f2e 0%, #0f1117 100%);
      border-bottom: 1px solid #2d3748;
      padding: 20px 32px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    header h1 { font-size: 1.4rem; font-weight: 700; color: #fff; letter-spacing: -0.5px; }
    header h1 span { color: #4299e1; }
    .status-pill {
      display: flex; align-items: center; gap: 8px;
      background: #1a2744; border: 1px solid #2d4a7a;
      border-radius: 20px; padding: 6px 14px; font-size: 0.8rem;
    }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: #48bb78; animation: pulse 2s infinite; }
    @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }

    main { max-width: 1100px; margin: 0 auto; padding: 32px 24px; }

    /* Config cards */
    .config-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin-bottom: 32px; }
    .config-card {
      background: #1a1f2e; border: 1px solid #2d3748; border-radius: 12px;
      padding: 20px; position: relative; overflow: hidden;
    }
    .config-card::before {
      content: ''; position: absolute; top: 0; left: 0; right: 0; height: 3px;
    }
    .config-card.strategy::before { background: #4299e1; }
    .config-card.instrument::before { background: #9f7aea; }
    .config-card.live::before { background: ${liveEnabled ? '#48bb78' : '#fc8181'}; }
    .config-card .label { font-size: 0.72rem; text-transform: uppercase; letter-spacing: 1px; color: #718096; margin-bottom: 8px; }
    .config-card .value { font-size: 1.1rem; font-weight: 700; color: #fff; }
    .config-card .sub { font-size: 0.78rem; color: #718096; margin-top: 4px; }
    .live-badge {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 4px 10px; border-radius: 6px; font-size: 0.82rem; font-weight: 600;
      background: ${liveEnabled ? '#1c4532' : '#2d1515'}; 
      color: ${liveEnabled ? '#68d391' : '#fc8181'};
      border: 1px solid ${liveEnabled ? '#276749' : '#9b2c2c'};
    }

    /* Section headers */
    .section-title {
      font-size: 0.85rem; font-weight: 600; text-transform: uppercase;
      letter-spacing: 1px; color: #718096; margin-bottom: 14px; margin-top: 32px;
      display: flex; align-items: center; gap: 8px;
    }
    .section-title::after {
      content: ''; flex: 1; height: 1px; background: #2d3748; margin-left: 12px;
    }

    /* Endpoint cards */
    .endpoint-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .endpoint-card {
      background: #1a1f2e; border: 1px solid #2d3748; border-radius: 10px;
      padding: 16px 18px; display: flex; align-items: flex-start; gap: 14px;
      text-decoration: none; color: inherit; transition: all 0.15s ease;
    }
    .endpoint-card:hover { border-color: #4a5568; background: #1e2433; transform: translateY(-1px); }
    .endpoint-card .method {
      font-size: 0.65rem; font-weight: 700; letter-spacing: 0.5px;
      padding: 3px 7px; border-radius: 5px; margin-top: 2px; flex-shrink: 0;
      background: #1a4a2e; color: #68d391; border: 1px solid #276749;
    }
    .endpoint-card .ep-content .ep-path { font-size: 0.95rem; font-weight: 600; color: #90cdf4; font-family: monospace; }
    .endpoint-card .ep-content .ep-desc { font-size: 0.78rem; color: #718096; margin-top: 4px; }
    .endpoint-card.warn .method { background: #2d1515; color: #fc8181; border-color: #9b2c2c; }
    .endpoint-card.warn:hover { border-color: #fc8181; }

    /* Strategies table */
    table { width: 100%; border-collapse: collapse; background: #1a1f2e; border-radius: 10px; overflow: hidden; border: 1px solid #2d3748; }
    th { background: #141824; padding: 12px 16px; text-align: left; font-size: 0.72rem; text-transform: uppercase; letter-spacing: 1px; color: #718096; }
    td { padding: 14px 16px; font-size: 0.87rem; border-top: 1px solid #2d3748; }
    .active-row td { background: rgba(66,153,225,0.05); }
    .badge { font-size: 0.68rem; font-weight: 700; padding: 3px 8px; border-radius: 5px; letter-spacing: 0.5px; }
    .badge-active { background: #1a3a5c; color: #63b3ed; border: 1px solid #2a5a8c; }
    .badge-inactive { background: #1a1f2e; color: #4a5568; border: 1px solid #2d3748; }

    /* Workflow steps */
    .steps { display: flex; flex-direction: column; gap: 10px; }
    .step {
      display: flex; align-items: flex-start; gap: 14px;
      background: #1a1f2e; border: 1px solid #2d3748; border-radius: 10px; padding: 14px 18px;
    }
    .step-num {
      width: 26px; height: 26px; border-radius: 50%; background: #1a3a5c;
      color: #63b3ed; font-size: 0.75rem; font-weight: 700; display: flex;
      align-items: center; justify-content: center; flex-shrink: 0; margin-top: 1px;
    }
    .step-text { font-size: 0.87rem; color: #a0aec0; line-height: 1.5; }
    .step-text code { background: #141824; color: #90cdf4; padding: 1px 6px; border-radius: 4px; font-size: 0.82rem; font-family: monospace; }
    .step-text a { color: #63b3ed; text-decoration: none; }
    .step-text a:hover { text-decoration: underline; }

    footer { text-align: center; padding: 32px; color: #4a5568; font-size: 0.78rem; border-top: 1px solid #1a1f2e; margin-top: 48px; }
  </style>
</head>
<body>

<header>
  <h1>📈 Fyers <span>Trading App</span></h1>
  <div class="status-pill"><div class="dot"></div> Server Running</div>
</header>

<main>

  <!-- Config Cards -->
  <div class="config-grid">
    <div class="config-card strategy">
      <div class="label">Active Strategy</div>
      <div class="value">${ACTIVE}</div>
      <div class="sub">${strategies.find(s=>s.active)?.name || ''}</div>
    </div>
    <div class="config-card instrument">
      <div class="label">Instrument</div>
      <div class="value">${INSTRUMENT.replace('_', ' ')}</div>
      <div class="sub">1 lot = 75 qty (NIFTY)</div>
    </div>
    <div class="config-card live">
      <div class="label">Live Trading</div>
      <div class="value">
        <span class="live-badge">
          ${liveEnabled ? '✅ ENABLED' : '🔒 DISABLED'}
        </span>
      </div>
      <div class="sub">${liveEnabled ? 'Real orders will be placed' : 'Set LIVE_TRADE_ENABLED=true to enable'}</div>
    </div>
  </div>

  <!-- Auth -->
  <div class="section-title">🔐 Authentication</div>
  <div class="endpoint-grid">
    <a href="/auth/login" target="_blank" rel="noopener" class="endpoint-card">
      <span class="method">GET</span>
      <div class="ep-content">
        <div class="ep-path">/auth/login</div>
        <div class="ep-desc">Redirect to Fyers OAuth login page</div>
      </div>
    </a>
    <a href="/auth/status" target="_blank" rel="noopener" class="endpoint-card">
      <span class="method">GET</span>
      <div class="ep-content">
        <div class="ep-path">/auth/status</div>
        <div class="ep-desc">Check if access token is set</div>
      </div>
    </a>
  </div>

  <!-- Backtest -->
  <div class="section-title">🔍 Backtest</div>
  <div style="background:#1a1f2e;border:1px solid #2d3748;border-radius:12px;padding:20px 24px;margin-bottom:12px;">
    <div style="display:flex;align-items:flex-end;gap:14px;flex-wrap:wrap;">
      <div>
        <label style="font-size:0.68rem;text-transform:uppercase;letter-spacing:1px;color:#718096;display:block;margin-bottom:6px;">From Date</label>
        <input type="date" id="bt-from" value="${backtestFrom}" style="background:#0f1117;border:1px solid #2d3748;color:#e2e8f0;padding:8px 12px;border-radius:7px;font-size:0.85rem;font-family:inherit;"/>
      </div>
      <div>
        <label style="font-size:0.68rem;text-transform:uppercase;letter-spacing:1px;color:#718096;display:block;margin-bottom:6px;">To Date</label>
        <input type="date" id="bt-to" value="${backtestTo}" style="background:#0f1117;border:1px solid #2d3748;color:#e2e8f0;padding:8px 12px;border-radius:7px;font-size:0.85rem;font-family:inherit;"/>
      </div>
      <div>
        <label style="font-size:0.68rem;text-transform:uppercase;letter-spacing:1px;color:#718096;display:block;margin-bottom:6px;">Candle Size</label>
        <select id="bt-res" style="background:#0f1117;border:1px solid #2d3748;color:#e2e8f0;padding:8px 12px;border-radius:7px;font-size:0.85rem;font-family:inherit;">
          <option value="5" selected>5-min</option>
          <option value="15">15-min</option>
          <option value="60">60-min</option>
        </select>
      </div>
      <button onclick="runBacktest()" style="background:#4299e1;color:#fff;border:none;padding:9px 20px;border-radius:7px;font-size:0.85rem;font-weight:600;cursor:pointer;white-space:nowrap;font-family:inherit;">🔍 Run Backtest →</button>
    </div>
    <div style="margin-top:12px;font-size:0.75rem;color:#4a5568;">Active strategy: <strong style="color:#4299e1;">${ACTIVE}</strong> &nbsp;·&nbsp; Results open in a new tab with full UI report</div>
  </div>
  <script>
    function runBacktest() {
      const from = document.getElementById('bt-from').value;
      const to   = document.getElementById('bt-to').value;
      const res  = document.getElementById('bt-res').value;
      if (!from || !to) { alert('Please set both From and To dates.'); return; }
      if (from >= to) { alert('From date must be before To date.'); return; }
      window.open('/backtest?from=' + from + '&to=' + to + '&resolution=' + res, '_blank');
    }
  </script>

  <!-- Results -->
  <div class="section-title">📊 Results</div>
  <div class="endpoint-grid">
    <a href="/result" target="_blank" rel="noopener" class="endpoint-card">
      <span class="method">GET</span>
      <div class="ep-content">
        <div class="ep-path">/result</div>
        <div class="ep-desc">View backtest result for active strategy (${ACTIVE})</div>
      </div>
    </a>
    <a href="/result/all" target="_blank" rel="noopener" class="endpoint-card">
      <span class="method">GET</span>
      <div class="ep-content">
        <div class="ep-path">/result/all</div>
        <div class="ep-desc">View all saved results for all strategies (STRATEGY_1 through 4)</div>
      </div>
    </a>
    <a href="/result/compare" target="_blank" rel="noopener" class="endpoint-card" style="grid-column: span 2;">
      <span class="method">GET</span>
      <div class="ep-content">
        <div class="ep-path">/result/compare</div>
        <div class="ep-desc">⭐ Side-by-side comparison of all strategies with auto-recommendation</div>
      </div>
    </a>
  </div>

  <!-- Paper Trading -->
  <div class="section-title">🟡 Paper Trading <span style="font-size:0.7rem;color:#d69e2e;margin-left:8px;font-weight:400;text-transform:none;">Live market data · No real orders</span></div>
  <div class="endpoint-grid">
    <a href="/paperTrade/start" target="_blank" rel="noopener" class="endpoint-card" style="border-color:#744210;">
      <span class="method" style="background:#2d1f00;color:#f6ad55;border-color:#744210;">GET</span>
      <div class="ep-content">
        <div class="ep-path" style="color:#f6ad55;">/paperTrade/start</div>
        <div class="ep-desc">Start simulating trades with live NIFTY data — zero real money risk</div>
      </div>
    </a>
    <a href="/paperTrade/stop" target="_blank" rel="noopener" class="endpoint-card warn">
      <span class="method">GET</span>
      <div class="ep-content">
        <div class="ep-path">/paperTrade/stop</div>
        <div class="ep-desc">Stop paper trading & save session summary to disk</div>
      </div>
    </a>
    <a href="/paperTrade/status" target="_blank" rel="noopener" class="endpoint-card" style="grid-column: span 2;">
      <span class="method">GET</span>
      <div class="ep-content">
        <div class="ep-path">/paperTrade/status</div>
        <div class="ep-desc">Live view — virtual position, unrealised PnL, capital, session log</div>
      </div>
    </a>
    <a href="/paperTrade/history" target="_blank" rel="noopener" class="endpoint-card">
      <span class="method">GET</span>
      <div class="ep-content">
        <div class="ep-path">/paperTrade/history</div>
        <div class="ep-desc">All past sessions with win rate, PnL & trade-by-trade breakdown</div>
      </div>
    </a>
    <a href="/paperTrade/reset" target="_blank" rel="noopener" class="endpoint-card warn">
      <span class="method">GET</span>
      <div class="ep-content">
        <div class="ep-path">/paperTrade/reset</div>
        <div class="ep-desc">Wipe all paper trade history & restore capital to ₹${(parseFloat(process.env.PAPER_TRADE_CAPITAL||"200000")).toLocaleString("en-IN")}</div>
      </div>
    </a>
  </div>

  <!-- Live Trading -->
  <div class="section-title">⚡ Live Trading</div>
  <div class="endpoint-grid">
    <a href="/trade/start" target="_blank" rel="noopener" class="endpoint-card ${liveEnabled ? '' : 'warn'}">
      <span class="method">GET</span>
      <div class="ep-content">
        <div class="ep-path">/trade/start</div>
        <div class="ep-desc">${liveEnabled ? 'Start live trading with ' + ACTIVE : '⚠️ Disabled — set LIVE_TRADE_ENABLED=true in .env first'}</div>
      </div>
    </a>
    <a href="/trade/stop" target="_blank" rel="noopener" class="endpoint-card warn">
      <span class="method">GET</span>
      <div class="ep-content">
        <div class="ep-path">/trade/stop</div>
        <div class="ep-desc">Stop trading & square off all open positions</div>
      </div>
    </a>
    <a href="/trade/status" target="_blank" rel="noopener" class="endpoint-card" style="grid-column: span 2;">
      <span class="method">GET</span>
      <div class="ep-content">
        <div class="ep-path">/trade/status</div>
        <div class="ep-desc">Live trading status — current position, candles loaded, recent activity log</div>
      </div>
    </a>
  </div>

  <!-- Strategies Table -->
  <div class="section-title">🧠 Strategies</div>
  <table>
    <thead>
      <tr>
        <th>Status</th>
        <th>Key</th>
        <th>Name</th>
        <th>Logic</th>
      </tr>
    </thead>
    <tbody>${strategyRows}</tbody>
  </table>

  <!-- Workflow -->
  <div class="section-title">🗺️ How To Use</div>
  <div class="steps">
    <div class="step">
      <div class="step-num">1</div>
      <div class="step-text">Fill in <code>APP_ID</code> and <code>SECRET_KEY</code> in your <code>.env</code> file, then restart the server.</div>
    </div>
    <div class="step">
      <div class="step-num">2</div>
      <div class="step-text"><a href="/auth/login" target="_blank" rel="noopener">Click here to login with Fyers →</a> You'll be redirected to Fyers OAuth. After login, your access token is set automatically.</div>
    </div>
    <div class="step">
      <div class="step-num">3</div>
      <div class="step-text">Set <code>ACTIVE_STRATEGY=STRATEGY_1</code> in <code>.env</code>, restart, then <a href="/backtest?from=${backtestFrom}&to=${backtestTo}" target="_blank" rel="noopener">run backtest →</a></div>
    </div>
    <div class="step">
      <div class="step-num">4</div>
      <div class="step-text">Switch to <code>STRATEGY_2</code>, restart, run backtest again. Repeat for <code>STRATEGY_3</code> and <code>STRATEGY_4</code>.</div>
    </div>
    <div class="step">
      <div class="step-num">5</div>
      <div class="step-text"><a href="/result/compare" target="_blank" rel="noopener">Compare all results →</a> The best strategy is recommended automatically based on PnL &amp; win rate.</div>
    </div>
    <div class="step">
      <div class="step-num">6</div>
      <div class="step-text">Set the winning strategy as <code>ACTIVE_STRATEGY</code>, then <a href="/paperTrade/start" target="_blank" rel="noopener">start paper trading →</a> Uses live market data but NO real orders. Monitor at <a href="/paperTrade/status" target="_blank" rel="noopener">/paperTrade/status →</a></div>
    </div>
    <div class="step">
      <div class="step-num">7</div>
      <div class="step-text">Check <a href="/paperTrade/history" target="_blank" rel="noopener">/paperTrade/history →</a> — if paper trade results are consistently good over a few days, you're ready to go live.</div>
    </div>
    <div class="step">
      <div class="step-num">8</div>
      <div class="step-text">Set <code>LIVE_TRADE_ENABLED=true</code> in <code>.env</code>, then <a href="/trade/start" target="_blank" rel="noopener">start live trading →</a></div>
    </div>
    <div class="step">
      <div class="step-num">9</div>
      <div class="step-text">Monitor your live position at <a href="/trade/status" target="_blank" rel="noopener">/trade/status →</a> and stop anytime with <a href="/trade/stop" target="_blank" rel="noopener">/trade/stop →</a></div>
    </div>
  </div>

</main>

<footer>Fyers Trading App &nbsp;·&nbsp; NIFTY Intraday &nbsp;·&nbsp; Built with fyers-api-v3</footer>

</body>
</html>`;

  res.setHeader("Content-Type", "text/html");
  res.send(html);
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 Fyers Trading App running at http://localhost:${PORT}`);
  console.log(`   Active Strategy : ${ACTIVE}`);
  console.log(`   Instrument      : ${INSTRUMENT}`);
  console.log(`   Live Trading    : ${process.env.LIVE_TRADE_ENABLED === "true" ? "✅ ENABLED" : "🔒 disabled (set LIVE_TRADE_ENABLED=true to enable)"}`);
  console.log(`\n📖 Open http://localhost:${PORT} in your browser — full clickable dashboard\n`);
});

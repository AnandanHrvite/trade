const express = require("express");
const router  = express.Router();
const { loadAll, loadResult } = require("../utils/resultStore");
const { getAllStrategies, ACTIVE } = require("../strategies");

// ── Shared HTML shell ─────────────────────────────────────────────────────────
function shell(title, body) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>${title} — Fyers Trading</title>
  <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet"/>
  <style>
    :root {
      --bg:       #080c14;
      --surface:  #0d1320;
      --border:   #1a2236;
      --border2:  #243048;
      --text:     #c8d8f0;
      --muted:    #4a6080;
      --accent:   #3b82f6;
      --green:    #10b981;
      --red:      #ef4444;
      --yellow:   #f59e0b;
      --purple:   #8b5cf6;
    }
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Space Grotesk', sans-serif;
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      padding-bottom: 60px;
    }
    /* ── Top nav ── */
    nav {
      display: flex; align-items: center; justify-content: space-between;
      padding: 16px 32px;
      border-bottom: 1px solid var(--border);
      background: var(--surface);
      position: sticky; top: 0; z-index: 10;
    }
    nav .brand { font-size: 1rem; font-weight: 700; color: #fff; letter-spacing: -0.3px; }
    nav .brand span { color: var(--accent); }
    nav .nav-links { display: flex; gap: 8px; }
    nav .nav-links a {
      font-size: 0.78rem; font-weight: 500; color: var(--muted);
      text-decoration: none; padding: 6px 12px; border-radius: 6px;
      border: 1px solid transparent; transition: all 0.15s;
    }
    nav .nav-links a:hover { color: var(--text); border-color: var(--border2); background: var(--border); }
    nav .nav-links a.active { color: var(--accent); border-color: #1d3b6e; background: #0a1e3d; }

    /* ── Page wrapper ── */
    .page { max-width: 1100px; margin: 0 auto; padding: 36px 24px; }
    .page-header { margin-bottom: 32px; }
    .page-header h1 { font-size: 1.6rem; font-weight: 700; color: #fff; letter-spacing: -0.5px; }
    .page-header p  { font-size: 0.88rem; color: var(--muted); margin-top: 6px; }
    .tag {
      display: inline-block; font-size: 0.68rem; font-weight: 700; letter-spacing: 1px;
      padding: 3px 8px; border-radius: 4px; text-transform: uppercase; margin-right: 8px;
    }
    .tag-blue   { background: #0a1e3d; color: var(--accent); border: 1px solid #1d3b6e; }
    .tag-green  { background: #052e16; color: var(--green);  border: 1px solid #065f46; }
    .tag-red    { background: #2d0a0a; color: var(--red);    border: 1px solid #7f1d1d; }
    .tag-yellow { background: #2d1f00; color: var(--yellow); border: 1px solid #78350f; }
    .tag-purple { background: #1e0a3d; color: var(--purple); border: 1px solid #4c1d95; }

    /* ── Stat cards ── */
    .stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px,1fr)); gap: 14px; margin-bottom: 28px; }
    .stat-card {
      background: var(--surface); border: 1px solid var(--border);
      border-radius: 12px; padding: 20px 18px;
      position: relative; overflow: hidden;
    }
    .stat-card::after {
      content: ''; position: absolute; top: 0; left: 0; right: 0; height: 2px;
    }
    .stat-card.blue::after   { background: var(--accent); }
    .stat-card.green::after  { background: var(--green); }
    .stat-card.red::after    { background: var(--red); }
    .stat-card.yellow::after { background: var(--yellow); }
    .stat-card.purple::after { background: var(--purple); }
    .stat-label { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 1px; color: var(--muted); margin-bottom: 10px; }
    .stat-value { font-size: 1.5rem; font-weight: 700; color: #fff; font-family: 'JetBrains Mono', monospace; }
    .stat-value.pos { color: var(--green); }
    .stat-value.neg { color: var(--red); }
    .stat-sub { font-size: 0.72rem; color: var(--muted); margin-top: 6px; }

    /* ── Section ── */
    .section { margin-bottom: 32px; }
    .section-title {
      font-size: 0.75rem; font-weight: 600; text-transform: uppercase;
      letter-spacing: 1.2px; color: var(--muted); margin-bottom: 14px;
      display: flex; align-items: center; gap: 10px;
    }
    .section-title::after { content:''; flex:1; height:1px; background: var(--border); }

    /* ── Table ── */
    .table-wrap { border: 1px solid var(--border); border-radius: 12px; overflow: hidden; }
    table { width: 100%; border-collapse: collapse; }
    thead th {
      background: #0a0f1c; padding: 11px 16px; text-align: left;
      font-size: 0.68rem; text-transform: uppercase; letter-spacing: 1px; color: var(--muted);
      font-weight: 600;
    }
    tbody tr { border-top: 1px solid var(--border); transition: background 0.1s; }
    tbody tr:hover { background: #0d1726; }
    tbody td {
      padding: 12px 16px; font-size: 0.84rem; color: var(--text);
      font-family: 'JetBrains Mono', monospace;
    }
    tbody td.label { font-family: 'Space Grotesk', sans-serif; color: var(--muted); font-size: 0.82rem; }
    .pos { color: var(--green) !important; }
    .neg { color: var(--red) !important; }

    /* ── Compare cards ── */
    .compare-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px,1fr)); gap: 16px; }
    .compare-card {
      background: var(--surface); border: 1px solid var(--border);
      border-radius: 14px; padding: 24px; position: relative; overflow: hidden;
      transition: border-color 0.15s;
    }
    .compare-card.best { border-color: var(--green); box-shadow: 0 0 0 1px #065f46 inset; }
    .compare-card.active-strat { border-color: var(--accent); }
    .compare-card .card-name { font-size: 1rem; font-weight: 700; color: #fff; margin-bottom: 4px; }
    .compare-card .card-desc { font-size: 0.75rem; color: var(--muted); margin-bottom: 18px; line-height: 1.4; }
    .compare-card .card-stat { display: flex; justify-content: space-between; align-items: baseline; padding: 7px 0; border-bottom: 1px solid var(--border); }
    .compare-card .card-stat:last-child { border-bottom: none; }
    .compare-card .cs-label { font-size: 0.73rem; color: var(--muted); }
    .compare-card .cs-val { font-size: 0.9rem; font-weight: 600; font-family: 'JetBrains Mono', monospace; }
    .compare-card .not-tested { color: var(--muted); font-size: 0.82rem; margin-top: 12px; font-style: italic; }
    .best-badge {
      position: absolute; top: 16px; right: 16px;
      background: #052e16; color: var(--green); border: 1px solid #065f46;
      font-size: 0.65rem; font-weight: 700; letter-spacing: 0.5px;
      padding: 3px 8px; border-radius: 4px; text-transform: uppercase;
    }

    /* ── Recommendation banner ── */
    .rec-banner {
      background: linear-gradient(135deg, #052e16 0%, #0a1e3d 100%);
      border: 1px solid #065f46; border-radius: 12px;
      padding: 20px 24px; margin-bottom: 28px;
      display: flex; align-items: center; gap: 16px;
    }
    .rec-icon { font-size: 2rem; flex-shrink: 0; }
    .rec-text h3 { font-size: 1rem; font-weight: 700; color: var(--green); margin-bottom: 4px; }
    .rec-text p  { font-size: 0.82rem; color: #a7f3d0; }

    /* ── Error state ── */
    .empty-state {
      text-align: center; padding: 60px 24px;
      background: var(--surface); border: 1px solid var(--border); border-radius: 14px;
    }
    .empty-state .emoji { font-size: 3rem; margin-bottom: 16px; }
    .empty-state h3 { font-size: 1.1rem; font-weight: 600; color: #fff; margin-bottom: 8px; }
    .empty-state p  { font-size: 0.85rem; color: var(--muted); margin-bottom: 20px; }
    .btn {
      display: inline-block; padding: 10px 20px; border-radius: 8px;
      font-size: 0.83rem; font-weight: 600; text-decoration: none;
      background: var(--accent); color: #fff; transition: opacity 0.15s;
    }
    .btn:hover { opacity: 0.85; }

    /* ── Trade list ── */
    .trade-row td.side-ce { color: var(--green); font-weight: 700; }
    .trade-row td.side-pe { color: var(--red);   font-weight: 700; }
  </style>
</head>
<body>
<nav>
  <div class="brand">📈 Fyers <span>Trading</span></div>
  <div class="nav-links">
    <a href="/">Dashboard</a>
    <a href="/result">My Result</a>
    <a href="/result/all">All Results</a>
    <a href="/result/compare">Compare</a>
    <a href="/paperTrade/status">Paper Status</a>
    <a href="/paperTrade/history">Paper History</a>
    <a href="/trade/status">Live Status</a>
  </div>
</nav>
<div class="page">
${body}
</div>
</body>
</html>`;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const inr = (n) => typeof n === "number" ? `₹${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "N/A";
const pct = (v) => v || "N/A";
const pnlClass = (n) => typeof n === "number" && n >= 0 ? "pos" : "neg";

function summaryCards(s) {
  const pnlCls = pnlClass(s.totalPnl);
  const ddCls  = "neg";
  return `
  <div class="stat-grid">
    <div class="stat-card blue">
      <div class="stat-label">Total Trades</div>
      <div class="stat-value">${s.totalTrades}</div>
      <div class="stat-sub">${s.wins}W · ${s.losses}L</div>
    </div>
    <div class="stat-card ${pnlCls === "pos" ? "green" : "red"}">
      <div class="stat-label">Total PnL</div>
      <div class="stat-value ${pnlCls}">${inr(s.totalPnl)}</div>
      <div class="stat-sub">After brokerage</div>
    </div>
    <div class="stat-card yellow">
      <div class="stat-label">Win Rate</div>
      <div class="stat-value">${pct(s.winRate)}</div>
      <div class="stat-sub">${s.wins} wins of ${s.totalTrades}</div>
    </div>
    <div class="stat-card red">
      <div class="stat-label">Max Drawdown</div>
      <div class="stat-value neg">${inr(s.maxDrawdown)}</div>
      <div class="stat-sub">Worst single trade</div>
    </div>
    <div class="stat-card purple">
      <div class="stat-label">Risk / Reward</div>
      <div class="stat-value">${s.riskReward || "N/A"}</div>
      <div class="stat-sub">Avg win ÷ avg loss</div>
    </div>
    <div class="stat-card blue">
      <div class="stat-label">Final Capital</div>
      <div class="stat-value ${pnlClass(s.finalCapital - 100000)}">${inr(s.finalCapital)}</div>
      <div class="stat-sub">Starting ₹1,00,000</div>
    </div>
  </div>`;
}

function tradesTable(trades) {
  if (!trades || trades.length === 0) return `<p style="color:var(--muted);font-size:0.85rem;">No trades recorded.</p>`;
  const rows = trades.map(t => {
    const sideCls = t.side === "CE" ? "side-ce" : "side-pe";
    const pnlCls2 = pnlClass(t.pnl);
    return `<tr class="trade-row">
      <td class="${sideCls}">${t.side}</td>
      <td>${t.entryTime || "—"}</td>
      <td>${t.exitTime  || "—"}</td>
      <td>${inr(t.entryPrice)}</td>
      <td>${inr(t.exitPrice)}</td>
      <td>${t.stopLoss && t.stopLoss !== "N/A" ? inr(parseFloat(t.stopLoss)) : "—"}</td>
      <td class="${pnlCls2}">${inr(t.pnl)}</td>
      <td style="color:var(--muted);font-size:0.75rem;max-width:200px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${t.exitReason || "—"}</td>
    </tr>`;
  }).join("");
  return `
  <div class="table-wrap">
    <table>
      <thead><tr>
        <th>Side</th><th>Entry Time</th><th>Exit Time</th>
        <th>Entry ₹</th><th>Exit ₹</th><th>SL ₹</th><th>PnL ₹</th><th>Exit Reason</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

// ── GET /result  (active strategy) ───────────────────────────────────────────
router.get("/", (req, res) => {
  const result = loadResult(ACTIVE);

  if (!result) {
    res.setHeader("Content-Type", "text/html");
    return res.status(404).send(shell("No Result", `
      <div class="empty-state">
        <div class="emoji">📭</div>
        <h3>No backtest result yet for ${ACTIVE}</h3>
        <p>Run the backtest first to see results here.</p>
        <a class="btn" href="/backtest">Run Backtest →</a>
      </div>`));
  }

  const s = result.summary;
  const p = result.params || {};

  res.setHeader("Content-Type", "text/html");
  res.send(shell(`${ACTIVE} Result`, `
    <div class="page-header">
      <div style="margin-bottom:10px;">
        <span class="tag tag-blue">BACKTEST</span>
        <span class="tag tag-green">${ACTIVE}</span>
        ${p.from ? `<span class="tag tag-yellow">${p.from} → ${p.to}</span>` : ""}
      </div>
      <h1>${s.strategy}</h1>
      <p>${s.description || ""}</p>
    </div>

    <div class="section">
      <div class="section-title">Summary</div>
      ${summaryCards(s)}
    </div>

    <div class="section">
      <div class="section-title">Trade Log (${result.trades ? result.trades.length : 0} trades)</div>
      ${tradesTable(result.trades)}
    </div>
  `));
});

// ── GET /result/all ───────────────────────────────────────────────────────────
router.get("/all", (req, res) => {
  const all = loadAll();

  if (Object.keys(all).length === 0) {
    res.setHeader("Content-Type", "text/html");
    return res.status(404).send(shell("All Results", `
      <div class="empty-state">
        <div class="emoji">📭</div>
        <h3>No backtest results found</h3>
        <p>Run backtest for each strategy to see results here.</p>
        <a class="btn" href="/backtest">Run Backtest →</a>
      </div>`));
  }

  const sections = Object.entries(all).map(([key, result]) => {
    const s = result.summary;
    const p = result.params || {};
    return `
    <div class="section">
      <div class="section-title">
        <span class="tag tag-blue">${key}</span> ${s.strategy}
        ${p.from ? `<span style="font-size:0.72rem;color:var(--muted);font-weight:400;text-transform:none;letter-spacing:0;">${p.from} → ${p.to}</span>` : ""}
      </div>
      ${summaryCards(s)}
      <div style="margin-top:14px;">
        <div class="section-title">Trades</div>
        ${tradesTable(result.trades)}
      </div>
    </div>`;
  }).join("<hr style='border:none;border-top:1px solid var(--border);margin:32px 0;'/>");

  res.setHeader("Content-Type", "text/html");
  res.send(shell("All Results", `
    <div class="page-header">
      <h1>All Strategy Results</h1>
      <p>${Object.keys(all).length} strategies tested</p>
    </div>
    ${sections}
  `));
});

// ── GET /result/compare ───────────────────────────────────────────────────────
router.get("/compare", (req, res) => {
  const all        = loadAll();
  const strategies = getAllStrategies();

  const comparison = strategies.map((s) => {
    const result = all[s.key];
    if (!result) return { ...s, tested: false };
    return { ...s, tested: true, summary: result.summary, params: result.params, savedAt: result.savedAt };
  });

  const tested = comparison.filter(c => c.tested);
  const best   = tested.length ? tested.reduce((a, b) => (a.summary.totalPnl > b.summary.totalPnl ? a : b)) : null;

  const cards = comparison.map(c => {
    const isBest   = best && c.key === best.key;
    const isActive = c.active;
    const cls = isBest ? "compare-card best" : isActive ? "compare-card active-strat" : "compare-card";

    if (!c.tested) return `
      <div class="${cls}">
        <div class="card-name">${c.key}</div>
        <div class="card-desc">${c.description}</div>
        <p class="not-tested">⚠️ Not tested yet — run /backtest with this strategy active</p>
      </div>`;

    const s = c.summary;
    const pnlCls2 = pnlClass(s.totalPnl);
    return `
      <div class="${cls}">
        ${isBest ? '<div class="best-badge">🏆 Best</div>' : ""}
        ${isActive ? '<div class="best-badge" style="background:#0a1e3d;color:var(--accent);border-color:#1d3b6e;">● Active</div>' : ""}
        <div class="card-name">${c.key} — ${s.strategy}</div>
        <div class="card-desc">${c.description}</div>
        <div class="card-stat"><span class="cs-label">Total PnL</span>       <span class="cs-val ${pnlCls2}">${inr(s.totalPnl)}</span></div>
        <div class="card-stat"><span class="cs-label">Win Rate</span>        <span class="cs-val">${pct(s.winRate)}</span></div>
        <div class="card-stat"><span class="cs-label">Total Trades</span>    <span class="cs-val">${s.totalTrades} (${s.wins}W/${s.losses}L)</span></div>
        <div class="card-stat"><span class="cs-label">Max Drawdown</span>    <span class="cs-val neg">${inr(s.maxDrawdown)}</span></div>
        <div class="card-stat"><span class="cs-label">Risk / Reward</span>   <span class="cs-val">${s.riskReward || "N/A"}</span></div>
        <div class="card-stat"><span class="cs-label">Final Capital</span>   <span class="cs-val ${pnlClass(s.finalCapital - 100000)}">${inr(s.finalCapital)}</span></div>
        <div class="card-stat"><span class="cs-label">Tested Period</span>   <span class="cs-val" style="font-size:0.75rem;">${c.params ? c.params.from + " → " + c.params.to : "—"}</span></div>
      </div>`;
  }).join("");

  const recBanner = best ? `
    <div class="rec-banner">
      <div class="rec-icon">🏆</div>
      <div class="rec-text">
        <h3>Recommended: ${best.key} — ${best.summary.strategy}</h3>
        <p>Best PnL of ${inr(best.summary.totalPnl)} with ${pct(best.summary.winRate)} win rate across ${best.summary.totalTrades} trades.
           Set <code style="background:#1a2236;padding:2px 6px;border-radius:4px;font-family:JetBrains Mono,monospace;">ACTIVE_STRATEGY=${best.key}</code> in your .env to use it.</p>
      </div>
    </div>` : `
    <div class="rec-banner" style="background:linear-gradient(135deg,#1c1000 0%,#1a1a0a 100%);border-color:#78350f;">
      <div class="rec-icon">⚠️</div>
      <div class="rec-text">
        <h3 style="color:var(--yellow);">Run backtests for all strategies first</h3>
        <p style="color:#fde68a;">Set each strategy in .env, restart, and run /backtest. Then come back here for a comparison.</p>
      </div>
    </div>`;

  res.setHeader("Content-Type", "text/html");
  res.send(shell("Compare Strategies", `
    <div class="page-header">
      <h1>Strategy Comparison</h1>
      <p>Side-by-side performance of all ${strategies.length} strategies</p>
    </div>
    ${recBanner}
    <div class="section">
      <div class="section-title">All Strategies</div>
      <div class="compare-grid">${cards}</div>
    </div>
  `));
});

module.exports = router;

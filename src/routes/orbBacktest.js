/**
 * ORB BACKTEST — /orb-backtest
 * ─────────────────────────────────────────────────────────────────────────────
 * Date-range backtest of the Opening Range Breakout strategy on historical
 * NIFTY 5-min candles. Option premium is approximated from spot moves using
 * delta (BACKTEST_DELTA) + theta decay (BACKTEST_THETA_DAY) — same approach
 * as scalpBacktest. Exits mirror the paper-trade route exactly (target%, SL%,
 * spot-target, opposite-side spot SL, EOD square-off, BE move).
 *
 * Routes:
 *   GET /orb-backtest               → form (no params) or run + render results
 * ─────────────────────────────────────────────────────────────────────────────
 */

const express = require("express");
const router  = express.Router();
const orbStrategy = require("../strategies/orb_breakout");
const { fetchCandles, fetchCandlesCachedBT } = require("../services/backtestEngine");
const { buildSidebar, sidebarCSS, faviconLink, modalCSS, modalJS, toastJS } = require("../utils/sharedNav");
const sharedSocketState = require("../utils/sharedSocketState");
const { getCharges } = require("../utils/charges");

const NIFTY_INDEX_SYMBOL = "NSE:NIFTY50-INDEX";

function _utcSecToIstMins(unixSec) {
  return Math.floor((unixSec + 19800) / 60) % 1440;
}
function _parseMin(envKey, fallback) {
  const v = (process.env[envKey] || fallback).trim();
  const [h, m] = v.split(":").map(Number);
  return h * 60 + (isNaN(m) ? 0 : m);
}

function istDateOf(unixSec) {
  // YYYY-MM-DD IST
  const d = new Date((unixSec + 19800) * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}
function istHHMM(unixSec) {
  const d = new Date((unixSec + 19800) * 1000);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

/**
 * Run ORB backtest over a list of candles spanning >=1 trading day.
 */
function runOrbBacktest(allCandles) {
  if (!allCandles || allCandles.length === 0) return { trades: [], summary: emptySummary() };

  const DELTA      = parseFloat(process.env.BACKTEST_DELTA || "0.55");
  const THETA_DAY  = parseFloat(process.env.BACKTEST_THETA_DAY || "8");
  const LOT_SIZE   = parseInt(process.env.NIFTY_LOT_SIZE || "65", 10);
  const TARGET_PCT = parseFloat(process.env.ORB_TARGET_PCT || "0.5");
  const STOP_PCT   = parseFloat(process.env.ORB_STOP_PCT   || "0.3");
  const TGT_RANGE_MULT = parseFloat(process.env.ORB_TARGET_RANGE_MULT || "1.5");
  const FORCED_EXIT_MIN = _parseMin("ORB_FORCED_EXIT", "15:15");
  const ENTRY_END_MIN   = _parseMin("ORB_ENTRY_END",   "12:00");

  // Approximate entry premium for an ATM option at NIFTY spot ~25000 ≈ 200
  // No live option chain in backtest → use a heuristic seeded by historical
  // averages so the percentage-based target/SL still has sensible absolute
  // values. Theta per day deducted regardless of move.
  const SEED_PREMIUM = parseFloat(process.env.ORB_BT_SEED_PREMIUM || "180");

  // Group candles by IST date
  const byDate = new Map();
  for (const c of allCandles) {
    const dt = istDateOf(c.time);
    if (!byDate.has(dt)) byDate.set(dt, []);
    byDate.get(dt).push(c);
  }

  const trades = [];

  for (const [dateStr, dayCandles] of byDate) {
    // Need at least the OR-formation window of candles (3+ for 15-min OR on 5-min bars)
    if (dayCandles.length < 5) continue;

    // Walk through the day, maintaining a "seen" list for signal evaluation
    let position = null;
    let tradesTaken = 0;
    const maxTrades = parseInt(process.env.ORB_MAX_DAILY_TRADES || "1", 10);

    for (let i = 0; i < dayCandles.length; i++) {
      const c = dayCandles[i];
      const istMin = _utcSecToIstMins(c.time);

      // ── EOD forced exit ───────────────────────────────────────────────
      if (position && istMin >= FORCED_EXIT_MIN) {
        closePosition(position, c.close, c.time, "EOD square-off (15:15)");
        trades.push(position);
        position = null;
        continue;
      }

      // ── In-position: check exits using THIS bar's range ───────────────
      if (position) {
        // Use intra-bar high/low to detect SL/target touches
        const _highRunUp   = position.side === "CE" ? c.high : c.low;
        const _lowRunDown  = position.side === "CE" ? c.low  : c.high;

        // Spot SL = opposite side of OR
        if (position.side === "CE" && c.low <= position.slSpot) {
          closePosition(position, position.slSpot, c.time, `Spot SL hit (${position.slSpot} = ORL)`);
          trades.push(position); position = null; continue;
        }
        if (position.side === "PE" && c.high >= position.slSpot) {
          closePosition(position, position.slSpot, c.time, `Spot SL hit (${position.slSpot} = ORH)`);
          trades.push(position); position = null; continue;
        }
        // Spot target = 1.5× range
        if (position.side === "CE" && c.high >= position.targetSpot) {
          closePosition(position, position.targetSpot, c.time, `Spot target hit (${position.targetSpot})`);
          trades.push(position); position = null; continue;
        }
        if (position.side === "PE" && c.low <= position.targetSpot) {
          closePosition(position, position.targetSpot, c.time, `Spot target hit (${position.targetSpot})`);
          trades.push(position); position = null; continue;
        }

        // Premium SL/target — convert close to approximate premium
        const candlesHeld = ((c.time - position.entryTime) / 60) / 5;  // 5-min bars
        const thetaCost   = (THETA_DAY * candlesHeld) / 78;             // ~78 5-min bars/day
        const spotMove    = position.side === "CE" ? (c.close - position.entrySpot) : (position.entrySpot - c.close);
        const approxPrem  = Math.max(0.05, position.optionEntryLtp + spotMove * DELTA - thetaCost / LOT_SIZE);

        if (approxPrem <= position.stopPremium) {
          closePosition(position, c.close, c.time, `Premium SL (~₹${approxPrem.toFixed(1)} <= ₹${position.stopPremium})`, approxPrem);
          trades.push(position); position = null; continue;
        }
        if (approxPrem >= position.targetPremium) {
          closePosition(position, c.close, c.time, `Premium target (~₹${approxPrem.toFixed(1)} >= ₹${position.targetPremium})`, approxPrem);
          trades.push(position); position = null; continue;
        }
      }

      // ── Flat → evaluate ORB signal on this closed candle ──────────────
      if (!position && tradesTaken < maxTrades && istMin < ENTRY_END_MIN) {
        // Pass the slice of day-candles up to and including this one
        const seen = dayCandles.slice(0, i + 1);
        const sig  = orbStrategy.getSignal(seen, { silent: true, alreadyTraded: tradesTaken >= maxTrades });
        if (sig.signal === "BUY_CE" || sig.signal === "BUY_PE") {
          position = {
            date:           dateStr,
            side:           sig.side,
            entryTime:      c.time,
            entryTimeStr:   istHHMM(c.time),
            entrySpot:      c.close,
            optionEntryLtp: SEED_PREMIUM,
            orh:            sig.orh, orl: sig.orl, rangePts: sig.rangePts,
            slSpot:         sig.slSpot,
            targetSpot:     sig.targetSpot,
            targetPremium:  parseFloat((SEED_PREMIUM * (1 + TARGET_PCT)).toFixed(2)),
            stopPremium:    parseFloat((SEED_PREMIUM * (1 - STOP_PCT)).toFixed(2)),
            signalStrength: sig.signalStrength,
            entryReason:    sig.reason,
          };
          tradesTaken++;
        }
      }
    }

    // If still open at end of day candles, close at last
    if (position) {
      closePosition(position, dayCandles[dayCandles.length - 1].close, dayCandles[dayCandles.length - 1].time, "EOD (end of day candles)");
      trades.push(position);
      position = null;
    }
  }

  function closePosition(pos, exitSpot, exitTime, reason, approxPremOverride) {
    const candlesHeld = ((exitTime - pos.entryTime) / 60) / 5;
    const thetaCost   = (THETA_DAY * candlesHeld) / 78;
    const spotMove    = pos.side === "CE" ? (exitSpot - pos.entrySpot) : (pos.entrySpot - exitSpot);
    const exitPrem    = approxPremOverride != null
      ? approxPremOverride
      : Math.max(0.05, pos.optionEntryLtp + spotMove * DELTA - thetaCost / LOT_SIZE);
    const charges = getCharges({ broker: "fyers", isFutures: false, entryPremium: pos.optionEntryLtp, exitPremium: exitPrem, qty: LOT_SIZE });
    const pnl = parseFloat(((exitPrem - pos.optionEntryLtp) * LOT_SIZE - charges).toFixed(2));
    pos.exitTime    = exitTime;
    pos.exitTimeStr = istHHMM(exitTime);
    pos.exitSpot    = exitSpot;
    pos.optionExitLtp = parseFloat(exitPrem.toFixed(2));
    pos.exitReason  = reason;
    pos.pnl         = pnl;
    pos.charges     = parseFloat(charges.toFixed(2));
    pos.candlesHeld = Math.round(candlesHeld);
  }

  // Summary
  const wins = trades.filter(t => t.pnl > 0).length;
  const losses = trades.filter(t => t.pnl < 0).length;
  const totalPnl = trades.reduce((a, t) => a + t.pnl, 0);
  const wr = trades.length ? ((wins / trades.length) * 100).toFixed(1) : "0.0";
  const summary = {
    trades: trades.length, wins, losses, winRate: parseFloat(wr),
    totalPnl: parseFloat(totalPnl.toFixed(2)),
    avgWin:  wins   ? parseFloat((trades.filter(t => t.pnl > 0).reduce((a, t) => a + t.pnl, 0) / wins).toFixed(2)) : 0,
    avgLoss: losses ? parseFloat((trades.filter(t => t.pnl < 0).reduce((a, t) => a + t.pnl, 0) / losses).toFixed(2)) : 0,
    delta: DELTA, thetaPerDay: THETA_DAY, seedPremium: SEED_PREMIUM,
  };
  return { trades, summary };
}

function emptySummary() {
  return { trades: 0, wins: 0, losses: 0, winRate: 0, totalPnl: 0, avgWin: 0, avgLoss: 0 };
}

// ── Route ───────────────────────────────────────────────────────────────────

router.get("/", async (req, res) => {
  const liveActive = sharedSocketState.getMode() === "SWING_LIVE";
  const { from, to } = req.query;

  if (!from || !to) {
    // Render form
    return res.send(renderShell({
      title: "ORB Backtest",
      liveActive,
      body: renderForm(),
    }));
  }

  try {
    const fromSec = Math.floor(new Date(from + "T00:00:00Z").getTime() / 1000) - 19800; // IST 00:00
    const toSec   = Math.floor(new Date(to   + "T23:59:59Z").getTime() / 1000) - 19800;
    console.log(`🔍 ORB Backtest: ${from} → ${to}`);
    const candles = await fetchCandlesCachedBT(NIFTY_INDEX_SYMBOL, "5", from, to, false);
    if (!candles || candles.length === 0) {
      return res.send(renderShell({
        title: "ORB Backtest — No Data",
        liveActive,
        body: `<div class="empty">No candles found for ${from} → ${to}. Check Fyers auth.</div>` + renderForm(from, to),
      }));
    }
    const { trades, summary } = runOrbBacktest(candles);
    return res.send(renderShell({
      title: "ORB Backtest Results",
      liveActive,
      body: renderResults(from, to, summary, trades) + renderForm(from, to),
    }));
  } catch (err) {
    console.error("[orb-backtest] error:", err);
    return res.status(500).send(renderShell({
      title: "ORB Backtest — Error",
      liveActive,
      body: `<div class="empty" style="color:#ef4444;">Backtest failed: ${err.message}</div>` + renderForm(from, to),
    }));
  }
});

function renderForm(from, to) {
  const today = new Date().toISOString().slice(0, 10);
  const def30 = (() => { const d = new Date(); d.setDate(d.getDate() - 30); return d.toISOString().slice(0, 10); })();
  const f = from || def30;
  const t = to   || today;
  return `<form method="get" class="run-form">
    <label>From <input type="date" name="from" value="${f}"/></label>
    <label>To <input type="date" name="to" value="${t}"/></label>
    <button type="submit" class="run-btn">▶ Run ORB Backtest</button>
  </form>`;
}

function renderResults(from, to, s, trades) {
  const pnlColor = s.totalPnl > 0 ? "#10b981" : s.totalPnl < 0 ? "#ef4444" : "#4a6080";
  const rows = trades.map(t => {
    const cls = t.pnl > 0 ? "pos" : t.pnl < 0 ? "neg" : "muted";
    return `<tr><td>${t.date}</td><td>${t.entryTimeStr}</td><td>${t.exitTimeStr}</td><td>${t.side}</td><td>${t.entrySpot}</td><td>${t.exitSpot}</td><td>${t.orl}/${t.orh}</td><td>${t.rangePts}</td><td>₹${t.optionEntryLtp}</td><td>₹${t.optionExitLtp}</td><td>${t.signalStrength}</td><td class="${cls}"><b>₹${t.pnl.toFixed(2)}</b></td><td style="color:#94a3b8">${t.exitReason}</td></tr>`;
  }).join("");
  return `
  <div class="stats">
    <div class="stat"><div class="stat-l">Range</div><div class="stat-v">${from} → ${to}</div></div>
    <div class="stat"><div class="stat-l">Trades</div><div class="stat-v">${s.trades}</div></div>
    <div class="stat"><div class="stat-l">Win Rate</div><div class="stat-v">${s.winRate}%</div></div>
    <div class="stat"><div class="stat-l">Wins / Losses</div><div class="stat-v">${s.wins} / ${s.losses}</div></div>
    <div class="stat"><div class="stat-l">Net P&L</div><div class="stat-v" style="color:${pnlColor};">₹${s.totalPnl.toFixed(2)}</div></div>
    <div class="stat"><div class="stat-l">Avg Win</div><div class="stat-v" style="color:#10b981;">₹${s.avgWin}</div></div>
    <div class="stat"><div class="stat-l">Avg Loss</div><div class="stat-v" style="color:#ef4444;">₹${s.avgLoss}</div></div>
    <div class="stat"><div class="stat-l">Seed Premium</div><div class="stat-v" style="color:#94a3b8;">δ=${s.delta} θ=₹${s.thetaPerDay}/day · seed=₹${s.seedPremium}</div></div>
  </div>
  <table>
    <tr><th>Date</th><th>Entry</th><th>Exit</th><th>Side</th><th>E.Spot</th><th>X.Spot</th><th>OR</th><th>Range</th><th>E.Opt</th><th>X.Opt</th><th>Sig</th><th>PnL</th><th>Exit Reason</th></tr>
    ${rows || `<tr><td colspan="13" style="text-align:center;color:#3a5070;padding:24px;">No trades in this range</td></tr>`}
  </table>`;
}

function renderShell({ title, liveActive, body }) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"/>${faviconLink()}<title>${title}</title>
<script>(function(){ if ('${process.env.UI_THEME || "dark"}' === 'light') document.documentElement.setAttribute('data-theme', 'light'); })();</script>
<style>
*{box-sizing:border-box;margin:0;padding:0;font-family:Inter,sans-serif;}
body{background:#040c18;color:#e0eaf8;}
${sidebarCSS()}
.main{flex:1;margin-left:200px;padding:16px 22px;}
@media(max-width:900px){.main{margin-left:0;padding:14px;}}
.title{font-size:1.05rem;font-weight:700;margin-bottom:8px;}
.run-form{display:flex;align-items:center;gap:10px;background:#07111f;border:0.5px solid #0e1e36;border-radius:10px;padding:10px 14px;margin:10px 0;}
.run-form label{font-size:0.7rem;color:#94a3b8;display:flex;align-items:center;gap:5px;}
.run-form input{background:#040c18;border:0.5px solid #0e1e36;border-radius:5px;padding:5px 8px;color:#e0eaf8;font-family:'IBM Plex Mono',monospace;font-size:0.7rem;}
.run-btn{background:#10b981;color:#040c18;border:0;border-radius:5px;padding:6px 14px;font-weight:700;cursor:pointer;font-size:0.7rem;letter-spacing:0.8px;text-transform:uppercase;}
.run-btn:hover{background:#34d399;}
.stats{display:flex;gap:10px;margin-bottom:14px;flex-wrap:wrap;}
.stat{background:#07111f;border:0.5px solid #0e1e36;border-radius:10px;padding:10px 14px;min-width:120px;}
.stat-l{font-size:0.55rem;text-transform:uppercase;letter-spacing:1.2px;color:#3a5070;}
.stat-v{font-size:1.05rem;font-weight:700;font-family:'IBM Plex Mono',monospace;}
.empty{text-align:center;color:#3a5070;padding:24px;background:#07111f;border:0.5px solid #0e1e36;border-radius:10px;margin:10px 0;}
table{width:100%;border-collapse:collapse;font-size:0.65rem;font-family:'IBM Plex Mono',monospace;background:#07111f;border:0.5px solid #0e1e36;border-radius:8px;overflow:hidden;}
th,td{padding:6px 8px;text-align:left;border-bottom:0.5px solid #0e1e36;}
th{background:#040c18;font-size:0.55rem;text-transform:uppercase;letter-spacing:1.2px;color:#3a5070;}
.pos{color:#10b981;}.neg{color:#ef4444;}.muted{color:#3a5070;}
</style></head><body>
${buildSidebar('orbBacktest', liveActive, false)}
<main class="main">
  <div class="title">🔍 ${title}</div>
  ${body}
</main>
</body></html>`;
}

module.exports = router;

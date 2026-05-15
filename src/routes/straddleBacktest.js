/**
 * STRADDLE BACKTEST — /straddle-backtest
 * ─────────────────────────────────────────────────────────────────────────────
 * Date-range backtest of the Long Straddle strategy. Two-leg ATM CE+PE
 * premium movement is approximated from spot moves using delta — gamma is
 * what really drives a straddle so this is a coarse proxy. For a long
 * straddle, big spot move in EITHER direction lifts the combined premium
 * (one leg's loss is more than offset by the other's gain when convex).
 *
 * Theta deducted from BOTH legs daily. Exits on combined-premium target/SL
 * (same rules as paper route) or time stop.
 *
 * Routes:
 *   GET /straddle-backtest              → form / run + render
 * ─────────────────────────────────────────────────────────────────────────────
 */

const express = require("express");
const router  = express.Router();
const straddleStrategy = require("../strategies/straddle_volatility");
const { fetchCandlesCachedBT } = require("../services/backtestEngine");
const { buildSidebar, sidebarCSS, faviconLink } = require("../utils/sharedNav");
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
  const d = new Date((unixSec + 19800) * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}
function istHHMM(unixSec) {
  const d = new Date((unixSec + 19800) * 1000);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

function runStraddleBacktest(allCandles) {
  if (!allCandles || allCandles.length < 30) return { trades: [], summary: emptySummary() };

  const DELTA      = parseFloat(process.env.BACKTEST_DELTA || "0.55");
  const THETA_DAY  = parseFloat(process.env.BACKTEST_THETA_DAY || "8");
  const LOT_SIZE   = parseInt(process.env.NIFTY_LOT_SIZE || "65", 10);
  const TARGET_PCT = parseFloat(process.env.STRADDLE_TARGET_PCT || "0.4");
  const STOP_PCT   = parseFloat(process.env.STRADDLE_STOP_PCT   || "0.25");
  const MAX_HOLD_D = parseFloat(process.env.STRADDLE_MAX_HOLD_DAYS || "3");
  const FORCED_EXIT_MIN = _parseMin("STRADDLE_FORCED_EXIT", "15:15");
  const ENTRY_START_MIN = _parseMin("STRADDLE_ENTRY_START", "09:30");
  const ENTRY_END_MIN   = _parseMin("STRADDLE_ENTRY_END",   "11:00");
  const SEED_CE_PREMIUM = parseFloat(process.env.STRADDLE_BT_SEED_CE || "120");
  const SEED_PE_PREMIUM = parseFloat(process.env.STRADDLE_BT_SEED_PE || "120");

  // No VIX in backtest — we'll pass null and let the strategy gate purely on
  // BB squeeze. Future: wire historical VIX candles from the VIX series.
  const trades = [];
  let position = null;
  let pairCount = 0;

  for (let i = 30; i < allCandles.length; i++) {
    const c = allCandles[i];
    const istMin = _utcSecToIstMins(c.time);

    // ── EOD forced exit on entry day ──────────────────────────────────────
    if (position) {
      const heldSec = c.time - position.entryTime;
      const heldDays = heldSec / 86400;

      // Approximate per-leg premium movement
      const _spotMoveCE = (c.close - position.entrySpot) * DELTA;   // CE gains on up
      const _spotMovePE = (position.entrySpot - c.close) * DELTA;   // PE gains on down
      // Theta deducted from BOTH legs
      const _thetaPerLeg = (THETA_DAY * heldDays);
      const cePrem = Math.max(0.05, position.entryCe + _spotMoveCE - _thetaPerLeg);
      const pePrem = Math.max(0.05, position.entryPe + _spotMovePE - _thetaPerLeg);
      const combined = cePrem + pePrem;

      // Combined target / SL
      if (combined >= position.targetNet) {
        closePair(position, c.time, cePrem, pePrem, `Combined target (₹${combined.toFixed(1)} >= ₹${position.targetNet})`);
        trades.push(position); position = null; continue;
      }
      if (combined <= position.stopNet) {
        closePair(position, c.time, cePrem, pePrem, `Combined SL (₹${combined.toFixed(1)} <= ₹${position.stopNet})`);
        trades.push(position); position = null; continue;
      }
      // Time stop
      if (heldDays > MAX_HOLD_D) {
        closePair(position, c.time, cePrem, pePrem, `Time stop (held ${heldDays.toFixed(1)}d > ${MAX_HOLD_D}d)`);
        trades.push(position); position = null; continue;
      }
      // EOD forced (within entry day's window only — straddle is positional so
      // we don't EOD-square-off on day 1; only on the final day)
      if (heldDays >= 0.9 && istMin >= FORCED_EXIT_MIN) {
        // approaching expiry-day-style cutoff — only if we're past MAX_HOLD - 1
        if (heldDays >= MAX_HOLD_D - 1) {
          closePair(position, c.time, cePrem, pePrem, `EOD T-1 (15:15 IST)`);
          trades.push(position); position = null; continue;
        }
      }
    }

    // ── Flat → evaluate straddle signal ──────────────────────────────────
    if (!position && istMin >= ENTRY_START_MIN && istMin < ENTRY_END_MIN) {
      const seen = allCandles.slice(Math.max(0, i - 60), i + 1);
      const sig  = straddleStrategy.getSignal(seen, { silent: true, alreadyOpen: false, vix: null });
      if (sig.signal === "ENTER_STRADDLE") {
        const netDebit = SEED_CE_PREMIUM + SEED_PE_PREMIUM;
        position = {
          date:           istDateOf(c.time),
          entryTime:      c.time,
          entryTimeStr:   istHHMM(c.time),
          entrySpot:      c.close,
          entryCe:        SEED_CE_PREMIUM,
          entryPe:        SEED_PE_PREMIUM,
          netDebit:       parseFloat(netDebit.toFixed(2)),
          targetNet:      parseFloat((netDebit * (1 + TARGET_PCT)).toFixed(2)),
          stopNet:        parseFloat((netDebit * (1 - STOP_PCT)).toFixed(2)),
          trigger:        sig.trigger,
          bbWidth:        sig.bbWidth,
          bbWidthAvg:     sig.bbWidthAvg,
          signalStrength: sig.signalStrength,
          entryReason:    sig.reason,
        };
        pairCount++;
      }
    }
  }
  // Close any remaining open straddle at the last candle
  if (position) {
    const c = allCandles[allCandles.length - 1];
    const heldDays = (c.time - position.entryTime) / 86400;
    const _spotMoveCE = (c.close - position.entrySpot) * DELTA;
    const _spotMovePE = (position.entrySpot - c.close) * DELTA;
    const _thetaPerLeg = (THETA_DAY * heldDays);
    const cePrem = Math.max(0.05, position.entryCe + _spotMoveCE - _thetaPerLeg);
    const pePrem = Math.max(0.05, position.entryPe + _spotMovePE - _thetaPerLeg);
    closePair(position, c.time, cePrem, pePrem, "End of backtest range");
    trades.push(position);
    position = null;
  }

  function closePair(pos, exitTime, exitCe, exitPe, reason) {
    const heldDays = (exitTime - pos.entryTime) / 86400;
    const chargesCE = getCharges({ broker: "fyers", isFutures: false, entryPremium: pos.entryCe, exitPremium: exitCe, qty: LOT_SIZE });
    const chargesPE = getCharges({ broker: "fyers", isFutures: false, entryPremium: pos.entryPe, exitPremium: exitPe, qty: LOT_SIZE });
    const cePnl = parseFloat(((exitCe - pos.entryCe) * LOT_SIZE - chargesCE).toFixed(2));
    const pePnl = parseFloat(((exitPe - pos.entryPe) * LOT_SIZE - chargesPE).toFixed(2));
    pos.exitTime    = exitTime;
    pos.exitTimeStr = istHHMM(exitTime);
    pos.exitSpot    = null;  // available via spotMove
    pos.exitCe      = parseFloat(exitCe.toFixed(2));
    pos.exitPe      = parseFloat(exitPe.toFixed(2));
    pos.cePnl       = cePnl;
    pos.pePnl       = pePnl;
    pos.pnl         = parseFloat((cePnl + pePnl).toFixed(2));
    pos.exitReason  = reason;
    pos.heldDays    = parseFloat(heldDays.toFixed(2));
  }

  const wins = trades.filter(t => t.pnl > 0).length;
  const losses = trades.filter(t => t.pnl < 0).length;
  const totalPnl = trades.reduce((a, t) => a + t.pnl, 0);
  const wr = trades.length ? ((wins / trades.length) * 100).toFixed(1) : "0.0";
  const summary = {
    trades: trades.length, wins, losses, winRate: parseFloat(wr),
    totalPnl: parseFloat(totalPnl.toFixed(2)),
    avgWin:  wins   ? parseFloat((trades.filter(t => t.pnl > 0).reduce((a, t) => a + t.pnl, 0) / wins).toFixed(2)) : 0,
    avgLoss: losses ? parseFloat((trades.filter(t => t.pnl < 0).reduce((a, t) => a + t.pnl, 0) / losses).toFixed(2)) : 0,
    delta: DELTA, thetaPerDay: THETA_DAY, seedCe: SEED_CE_PREMIUM, seedPe: SEED_PE_PREMIUM,
  };
  return { trades, summary };
}

function emptySummary() {
  return { trades: 0, wins: 0, losses: 0, winRate: 0, totalPnl: 0, avgWin: 0, avgLoss: 0 };
}

router.get("/", async (req, res) => {
  const liveActive = sharedSocketState.getMode() === "SWING_LIVE";
  const { from, to } = req.query;
  if (!from || !to) {
    return res.send(renderShell({ title: "Straddle Backtest", liveActive, body: renderForm() }));
  }
  try {
    console.log(`🔍 Straddle Backtest: ${from} → ${to}`);
    const candles = await fetchCandlesCachedBT(NIFTY_INDEX_SYMBOL, "5", from, to, false);
    if (!candles || candles.length === 0) {
      return res.send(renderShell({
        title: "Straddle Backtest — No Data",
        liveActive,
        body: `<div class="empty">No candles for ${from} → ${to}.</div>` + renderForm(from, to),
      }));
    }
    const { trades, summary } = runStraddleBacktest(candles);
    return res.send(renderShell({
      title: "Straddle Backtest Results",
      liveActive,
      body: renderResults(from, to, summary, trades) + renderForm(from, to),
    }));
  } catch (err) {
    console.error("[straddle-backtest] error:", err);
    return res.status(500).send(renderShell({
      title: "Straddle Backtest — Error",
      liveActive,
      body: `<div class="empty" style="color:#ef4444;">Backtest failed: ${err.message}</div>` + renderForm(from, to),
    }));
  }
});

function renderForm(from, to) {
  const today = new Date().toISOString().slice(0, 10);
  const def30 = (() => { const d = new Date(); d.setDate(d.getDate() - 30); return d.toISOString().slice(0, 10); })();
  return `<form method="get" class="run-form">
    <label>From <input type="date" name="from" value="${from || def30}"/></label>
    <label>To <input type="date" name="to" value="${to || today}"/></label>
    <button type="submit" class="run-btn">▶ Run Straddle Backtest</button>
  </form>
  <div style="font-size:0.65rem;color:#94a3b8;margin-top:8px;">⚠️ Note: Straddle backtest approximates premium via delta. Real straddles are dominated by gamma + vega which a delta-only proxy understates — treat results as directional only, not absolute.</div>`;
}

function renderResults(from, to, s, trades) {
  const pnlColor = s.totalPnl > 0 ? "#10b981" : s.totalPnl < 0 ? "#ef4444" : "#4a6080";
  const rows = trades.map(t => {
    const cls = t.pnl > 0 ? "pos" : t.pnl < 0 ? "neg" : "muted";
    return `<tr><td>${t.date}</td><td>${t.entryTimeStr}</td><td>${t.exitTimeStr}</td><td>${t.heldDays}d</td><td>${t.entrySpot}</td><td>${t.netDebit}</td><td>₹${t.entryCe}/${t.exitCe} (${t.cePnl >= 0 ? "+" : ""}${t.cePnl})</td><td>₹${t.entryPe}/${t.exitPe} (${t.pePnl >= 0 ? "+" : ""}${t.pePnl})</td><td>${t.trigger}</td><td>${t.signalStrength}</td><td class="${cls}"><b>₹${t.pnl.toFixed(2)}</b></td><td style="color:#94a3b8">${t.exitReason}</td></tr>`;
  }).join("");
  return `
  <div class="stats">
    <div class="stat"><div class="stat-l">Range</div><div class="stat-v">${from} → ${to}</div></div>
    <div class="stat"><div class="stat-l">Pairs</div><div class="stat-v">${s.trades}</div></div>
    <div class="stat"><div class="stat-l">Win Rate</div><div class="stat-v">${s.winRate}%</div></div>
    <div class="stat"><div class="stat-l">Wins / Losses</div><div class="stat-v">${s.wins} / ${s.losses}</div></div>
    <div class="stat"><div class="stat-l">Net P&L</div><div class="stat-v" style="color:${pnlColor};">₹${s.totalPnl.toFixed(2)}</div></div>
    <div class="stat"><div class="stat-l">Avg Win</div><div class="stat-v" style="color:#10b981;">₹${s.avgWin}</div></div>
    <div class="stat"><div class="stat-l">Avg Loss</div><div class="stat-v" style="color:#ef4444;">₹${s.avgLoss}</div></div>
    <div class="stat"><div class="stat-l">Sim Params</div><div class="stat-v" style="color:#94a3b8;">δ=${s.delta} θ=₹${s.thetaPerDay}/d · seedCE=${s.seedCe} seedPE=${s.seedPe}</div></div>
  </div>
  <table>
    <tr><th>Date</th><th>Entry</th><th>Exit</th><th>Held</th><th>Spot</th><th>Net Debit</th><th>CE</th><th>PE</th><th>Trigger</th><th>Sig</th><th>Pair PnL</th><th>Exit Reason</th></tr>
    ${rows || `<tr><td colspan="12" style="text-align:center;color:#3a5070;padding:24px;">No pairs in this range</td></tr>`}
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
.run-btn{background:#ec4899;color:#040c18;border:0;border-radius:5px;padding:6px 14px;font-weight:700;cursor:pointer;font-size:0.7rem;letter-spacing:0.8px;text-transform:uppercase;}
.run-btn:hover{background:#f472b6;}
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
${buildSidebar('straddleBacktest', liveActive, false)}
<main class="main">
  <div class="title">🔍 ${title}</div>
  ${body}
</main>
</body></html>`;
}

module.exports = router;

/**
 * STRADDLE BACKTEST — /straddle-backtest
 * ─────────────────────────────────────────────────────────────────────────────
 * Date-range Long Straddle backtest using the shared backtest UI helper.
 * Paired CE+PE premium movement approximated from spot delta + theta decay.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const express = require("express");
const router  = express.Router();
const straddleStrategy = require("../strategies/straddle_volatility");
const { fetchCandlesCachedBT } = require("../services/backtestEngine");
const { buildSidebar, sidebarCSS, faviconLink } = require("../utils/sharedNav");
const sharedSocketState = require("../utils/sharedSocketState");
const { getCharges } = require("../utils/charges");
const { renderBacktestResults, computeBacktestStats } = require("../utils/backtestUI");

const NIFTY_INDEX_SYMBOL = "NSE:NIFTY50-INDEX";
const ACCENT = "#ec4899";
const ENDPOINT = "/straddle-backtest";

function _utcSecToIstMins(unixSec) { return Math.floor((unixSec + 19800) / 60) % 1440; }
function _parseMin(envKey, fallback) {
  const v = (process.env[envKey] || fallback).trim();
  const [h, m] = v.split(":").map(Number);
  return h * 60 + (isNaN(m) ? 0 : m);
}
function istDateOf(unixSec) {
  const d = new Date((unixSec + 19800) * 1000);
  return `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${d.getUTCFullYear()}`;
}
function istHHMMSS(unixSec) {
  const d = new Date((unixSec + 19800) * 1000);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}:${String(d.getUTCSeconds()).padStart(2, "0")}`;
}
function entryTsStr(unixSec) { return `${istDateOf(unixSec)}, ${istHHMMSS(unixSec)}`; }

function runStraddleBacktest(allCandles) {
  if (!allCandles || allCandles.length < 30) return [];

  const DELTA      = parseFloat(process.env.BACKTEST_DELTA || "0.55");
  const THETA_DAY  = parseFloat(process.env.BACKTEST_THETA_DAY || "8");
  const LOT_SIZE   = parseInt(process.env.NIFTY_LOT_SIZE || "65", 10);
  const TARGET_PCT = parseFloat(process.env.STRADDLE_TARGET_PCT || "0.4");
  const STOP_PCT   = parseFloat(process.env.STRADDLE_STOP_PCT   || "0.25");
  const MAX_HOLD_D = parseFloat(process.env.STRADDLE_MAX_HOLD_DAYS || "3");
  const FORCED_EXIT_MIN = _parseMin("STRADDLE_FORCED_EXIT", "15:15");
  const ENTRY_START_MIN = _parseMin("STRADDLE_ENTRY_START", "09:30");
  const ENTRY_END_MIN   = _parseMin("STRADDLE_ENTRY_END",   "11:00");
  const SEED_CE = parseFloat(process.env.STRADDLE_BT_SEED_CE || "120");
  const SEED_PE = parseFloat(process.env.STRADDLE_BT_SEED_PE || "120");

  const trades = [];
  let position = null;

  for (let i = 30; i < allCandles.length; i++) {
    const c = allCandles[i];
    const istMin = _utcSecToIstMins(c.time);

    if (position) {
      const heldDays = (c.time - position.entryTime) / 86400;
      const spotMoveCE = (c.close - position.entrySpot) * DELTA;
      const spotMovePE = (position.entrySpot - c.close) * DELTA;
      const thetaPerLeg = THETA_DAY * heldDays;
      const cePrem = Math.max(0.05, position.entryCe + spotMoveCE - thetaPerLeg);
      const pePrem = Math.max(0.05, position.entryPe + spotMovePE - thetaPerLeg);
      const combined = cePrem + pePrem;

      if (combined >= position.targetNet) {
        closePair(position, c.time, cePrem, pePrem, `Combined target (₹${combined.toFixed(1)} >= ₹${position.targetNet})`);
        trades.push(buildTradeRecord(position));
        position = null; continue;
      }
      if (combined <= position.stopNet) {
        closePair(position, c.time, cePrem, pePrem, `Combined SL (₹${combined.toFixed(1)} <= ₹${position.stopNet})`);
        trades.push(buildTradeRecord(position));
        position = null; continue;
      }
      if (heldDays > MAX_HOLD_D) {
        closePair(position, c.time, cePrem, pePrem, `Time stop (held ${heldDays.toFixed(1)}d > ${MAX_HOLD_D}d)`);
        trades.push(buildTradeRecord(position));
        position = null; continue;
      }
      if (heldDays >= MAX_HOLD_D - 1 && istMin >= FORCED_EXIT_MIN) {
        closePair(position, c.time, cePrem, pePrem, "EOD T-1 (15:15 IST)");
        trades.push(buildTradeRecord(position));
        position = null; continue;
      }
    }

    if (!position && istMin >= ENTRY_START_MIN && istMin < ENTRY_END_MIN) {
      const seen = allCandles.slice(Math.max(0, i - 60), i + 1);
      const sig  = straddleStrategy.getSignal(seen, { silent: true, alreadyOpen: false, vix: null });
      if (sig.signal === "ENTER_STRADDLE") {
        const netDebit = SEED_CE + SEED_PE;
        position = {
          date: istDateOf(c.time),
          entryTime: c.time,
          entrySpot: c.close,
          entryCe: SEED_CE, entryPe: SEED_PE,
          netDebit: parseFloat(netDebit.toFixed(2)),
          targetNet: parseFloat((netDebit * (1 + TARGET_PCT)).toFixed(2)),
          stopNet:   parseFloat((netDebit * (1 - STOP_PCT)).toFixed(2)),
          trigger: sig.trigger,
          bbWidth: sig.bbWidth,
          bbWidthAvg: sig.bbWidthAvg,
          signalStrength: sig.signalStrength,
          entryReason: sig.reason,
        };
      }
    }
  }

  // Close any final open
  if (position) {
    const c = allCandles[allCandles.length - 1];
    const heldDays = (c.time - position.entryTime) / 86400;
    const spotMoveCE = (c.close - position.entrySpot) * DELTA;
    const spotMovePE = (position.entrySpot - c.close) * DELTA;
    const thetaPerLeg = THETA_DAY * heldDays;
    const cePrem = Math.max(0.05, position.entryCe + spotMoveCE - thetaPerLeg);
    const pePrem = Math.max(0.05, position.entryPe + spotMovePE - thetaPerLeg);
    closePair(position, c.time, cePrem, pePrem, "End of backtest range");
    trades.push(buildTradeRecord(position));
  }

  function closePair(pos, exitTime, exitCe, exitPe, reason) {
    const chargesCE = getCharges({ broker: "fyers", isFutures: false, entryPremium: pos.entryCe, exitPremium: exitCe, qty: LOT_SIZE });
    const chargesPE = getCharges({ broker: "fyers", isFutures: false, entryPremium: pos.entryPe, exitPremium: exitPe, qty: LOT_SIZE });
    const cePnl = parseFloat(((exitCe - pos.entryCe) * LOT_SIZE - chargesCE).toFixed(2));
    const pePnl = parseFloat(((exitPe - pos.entryPe) * LOT_SIZE - chargesPE).toFixed(2));
    pos.exitTime = exitTime;
    pos.exitCe = parseFloat(exitCe.toFixed(2));
    pos.exitPe = parseFloat(exitPe.toFixed(2));
    pos.cePnl = cePnl; pos.pePnl = pePnl;
    pos.pnl = parseFloat((cePnl + pePnl).toFixed(2));
    pos.exitReason = reason;
    pos.heldDays = parseFloat(((exitTime - pos.entryTime) / 86400).toFixed(2));
  }

  function buildTradeRecord(p) {
    return {
      side: "STRADDLE",
      entry: entryTsStr(p.entryTime),
      exit:  entryTsStr(p.exitTime),
      entryTs: p.entryTime, exitTs: p.exitTime,
      ePrice: p.entrySpot, xPrice: null, sl: p.stopNet,
      pnl: p.pnl,
      reason: p.exitReason,
      entryReason: p.entryReason,
      // Straddle-specific
      netDebit: p.netDebit,
      targetNet: p.targetNet,
      stopNet: p.stopNet,
      cePnl: p.cePnl, pePnl: p.pePnl,
      trigger: p.trigger,
      strength: p.signalStrength,
      heldDays: p.heldDays,
    };
  }

  return trades;
}

router.get("/idle", (req, res) => res.redirect("/straddle-backtest"));

router.get("/", async (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.send(renderIdleForm());

  try {
    console.log(`🔍 Straddle Backtest: ${from} → ${to}`);
    const candles = await fetchCandlesCachedBT(NIFTY_INDEX_SYMBOL, "5", from, to, false);
    const trades = runStraddleBacktest(candles || []);
    const stats = computeBacktestStats(trades);

    const html = renderBacktestResults({
      mode: "STRADDLE",
      accent: ACCENT,
      strategyName: straddleStrategy.NAME,
      endpoint: ENDPOINT,
      from, to,
      summary: stats,
      trades,
      activePage: "straddleBacktest",
      extraTradeColumns: [
        { key: "trigger", label: "Trigger" },
        { key: "netDebit", label: "Debit ₹" },
        { key: "heldDays", label: "Held (d)" },
      ],
      extraStats: [
        { label: "Avg Net Debit", value: trades.length ? `₹${Math.round(trades.reduce((a, t) => a + (t.netDebit || 0), 0) / trades.length).toLocaleString("en-IN")}` : "—" },
        { label: "Avg Hold (days)", value: trades.length ? (trades.reduce((a, t) => a + (t.heldDays || 0), 0) / trades.length).toFixed(2) : "—" },
        { label: "BB Squeeze Entries", value: trades.filter(t => t.trigger === "BB_SQUEEZE").length },
        { label: "Low-VIX Entries", value: trades.filter(t => t.trigger === "LOW_VIX_CHEAP").length },
      ],
      notes: "⚠️ Premium is approximated using delta only — real straddles are dominated by gamma + vega. Treat results as directional only, not absolute. Use Paper Trade for live-validation.",
    });
    res.send(html);
  } catch (err) {
    console.error("[straddle-backtest] error:", err);
    res.status(500).send(renderErrorPage(err.message, from, to));
  }
});

function renderIdleForm() {
  const liveActive = sharedSocketState.getMode() === "SWING_LIVE";
  const today = new Date().toISOString().slice(0, 10);
  const def30 = (() => { const d = new Date(); d.setDate(d.getDate() - 30); return d.toISOString().slice(0, 10); })();
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"/>${faviconLink()}<title>Straddle Backtest</title>
<script>(function(){ if ('${process.env.UI_THEME || "dark"}' === 'light') document.documentElement.setAttribute('data-theme', 'light'); })();</script>
<style>
*{box-sizing:border-box;margin:0;padding:0;font-family:'IBM Plex Mono',monospace;}
body{background:#060810;color:#a0b8d8;}
${sidebarCSS()}
.main{flex:1;margin-left:200px;padding:20px;}
@media(max-width:900px){.main{margin-left:0;padding:14px;}}
.title{font-size:1.1rem;font-weight:700;color:#e0eaf8;margin-bottom:6px;}
.sub{font-size:0.72rem;color:#4a6080;margin-bottom:18px;}
.run-form{display:flex;align-items:flex-end;gap:10px;background:#08091a;border:0.5px solid #0e1428;border-radius:10px;padding:14px 18px;flex-wrap:wrap;}
.run-form label{font-size:0.62rem;text-transform:uppercase;letter-spacing:1.2px;color:#4a6080;display:block;margin-bottom:4px;}
.run-form input{background:#fff;border:1px solid #1e3a8a;color:#0f172a;padding:6px 10px;border-radius:5px;font-size:0.78rem;font-family:inherit;}
.run-btn{background:${ACCENT};color:#040c18;border:1px solid ${ACCENT};padding:7px 16px;border-radius:5px;font-size:0.72rem;font-weight:700;cursor:pointer;font-family:inherit;}
.run-btn:hover{filter:brightness(1.15);}
.preset-row{display:flex;gap:6px;margin-top:14px;flex-wrap:wrap;}
.preset-btn{font-size:0.65rem;padding:4px 12px;border-radius:4px;background:rgba(236,72,153,0.08);color:${ACCENT};border:0.5px solid rgba(236,72,153,0.2);cursor:pointer;font-family:inherit;}
.preset-btn:hover{background:rgba(236,72,153,0.18);}
.notes{margin-top:18px;font-size:0.72rem;color:#94a3b8;background:#08091a;border:0.5px solid #0e1428;border-radius:8px;padding:14px 16px;}
</style></head><body>
<div class="app-shell">
${buildSidebar('straddleBacktest', liveActive)}
<main class="main">
  <div class="title">🔍 Straddle Backtest</div>
  <div class="sub">Long Straddle (ATM CE+PE) — date-range historical backtest with BB-squeeze / low-VIX triggers and delta+theta premium simulation.</div>
  <form method="get" class="run-form">
    <div><label>From</label><input type="date" name="from" value="${def30}"/></div>
    <div><label>To</label><input type="date" name="to" value="${today}"/></div>
    <button type="submit" class="run-btn">▶ Run Backtest</button>
  </form>
  <div class="preset-row">
    <button class="preset-btn" onclick="goto('thisWeek')">This week</button>
    <button class="preset-btn" onclick="goto('thisMonth')">This month</button>
    <button class="preset-btn" onclick="goto('last3')">Last 3 months</button>
    <button class="preset-btn" onclick="goto('last6')">Last 6 months</button>
    <button class="preset-btn" onclick="goto('thisYear')">This year</button>
    <button class="preset-btn" onclick="goto('lastYear')">Last year</button>
    <button class="preset-btn" onclick="goto('last2y')">Last 2 yr</button>
    <button class="preset-btn" onclick="goto('last3y')">Last 3 yr</button>
  </div>
  <div class="notes">
    <b>⚠️ Sim caveat:</b> Premium uses delta only (BACKTEST_DELTA=${process.env.BACKTEST_DELTA || "0.55"}). Real straddles profit from gamma + vega which a delta-only proxy understates. Backtest results are directional only — for absolute P&L, use Paper Trade with live option chain.
  </div>
</main>
<script>
function goto(p){
  var d=new Date(),y=d.getFullYear(),m=d.getMonth(),day=d.getDay();
  function f(dt){return dt.getFullYear()+'-'+String(dt.getMonth()+1).padStart(2,'0')+'-'+String(dt.getDate()).padStart(2,'0');}
  var today=f(d);
  var monday=new Date(d); monday.setDate(d.getDate()-(day===0?6:day-1));
  var presets={thisWeek:[f(monday),today],thisMonth:[f(new Date(y,m,1)),today],last3:[f(new Date(y,m-2,1)),today],last6:[f(new Date(y,m-5,1)),today],thisYear:[f(new Date(y,0,1)),today],lastYear:[f(new Date(y-1,0,1)),f(new Date(y-1,11,31))],last2y:[f(new Date(y-2,0,1)),today],last3y:[f(new Date(y-3,0,1)),today]};
  var p2=presets[p];
  window.location='/straddle-backtest?from='+p2[0]+'&to='+p2[1];
}
</script>
</div></body></html>`;
}

function renderErrorPage(msg, from, to) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"/>${faviconLink()}<title>Straddle Backtest Error</title>
<style>body{font-family:'IBM Plex Mono',monospace;background:#060810;color:#a0b8d8;padding:40px;text-align:center;}
h2{color:#ef4444;margin-bottom:12px;}p{margin-bottom:18px;}
a{color:${ACCENT};text-decoration:none;border:0.5px solid #0e1428;padding:8px 14px;border-radius:6px;}</style>
</head><body><h2>Straddle Backtest Failed</h2><p>${msg}</p><p><b>${from || ""}</b> → <b>${to || ""}</b></p><a href="/straddle-backtest">← Back</a></body></html>`;
}

module.exports = router;

/**
 * ORB BACKTEST — /orb-backtest
 * ─────────────────────────────────────────────────────────────────────────────
 * Date-range backtest of the Opening Range Breakout strategy. Reuses the
 * shared backtest UI helper for full parity with scalp/PA backtest pages.
 *
 * Endpoints:
 *   GET /orb-backtest                → form (no params)
 *   GET /orb-backtest?from=&to=      → run + render results
 *   GET /orb-backtest/idle           → idle landing
 * ─────────────────────────────────────────────────────────────────────────────
 */

const express = require("express");
const router  = express.Router();
const orbStrategy = require("../strategies/orb_breakout");
const { fetchCandlesCachedBT } = require("../services/backtestEngine");
const { buildSidebar, sidebarCSS, faviconLink } = require("../utils/sharedNav");
const sharedSocketState = require("../utils/sharedSocketState");
const { getCharges } = require("../utils/charges");
const { renderBacktestResults, computeBacktestStats } = require("../utils/backtestUI");
const { saveResult } = require("../utils/resultStore");

const NIFTY_INDEX_SYMBOL = "NSE:NIFTY50-INDEX";
const ACCENT = "#10b981";
const ENDPOINT = "/orb-backtest";
const RESULT_KEY = "ORB_BACKTEST";

// Simple in-flight flag so /all-backtest can poll /idle while the synchronous
// backtest is running. Set true on entry, false in finally.
let _inflight = false;

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

function runOrbBacktest(allCandles) {
  if (!allCandles || !allCandles.length) return [];

  const DELTA      = parseFloat(process.env.BACKTEST_DELTA || "0.55");
  const THETA_DAY  = parseFloat(process.env.BACKTEST_THETA_DAY || "8");
  const LOT_SIZE   = parseInt(process.env.NIFTY_LOT_SIZE || "65", 10);
  const TARGET_PCT = parseFloat(process.env.ORB_TARGET_PCT || "0.5");
  const STOP_PCT   = parseFloat(process.env.ORB_STOP_PCT   || "0.3");
  const TGT_RANGE_MULT = parseFloat(process.env.ORB_TARGET_RANGE_MULT || "1.5");
  const FORCED_EXIT_MIN = _parseMin("ORB_FORCED_EXIT", "15:15");
  const ENTRY_END_MIN   = _parseMin("ORB_ENTRY_END",   "12:00");
  const SEED_PREMIUM    = parseFloat(process.env.ORB_BT_SEED_PREMIUM || "180");

  const byDate = new Map();
  for (const c of allCandles) {
    const d = new Date((c.time + 19800) * 1000);
    const dt = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
    if (!byDate.has(dt)) byDate.set(dt, []);
    byDate.get(dt).push(c);
  }

  const trades = [];

  for (const [_dateStr, dayCandles] of byDate) {
    if (dayCandles.length < 5) continue;
    let position = null;
    let tradesTaken = 0;
    const maxTrades = parseInt(process.env.ORB_MAX_DAILY_TRADES || "1", 10);

    for (let i = 0; i < dayCandles.length; i++) {
      const c = dayCandles[i];
      const istMin = _utcSecToIstMins(c.time);

      // EOD forced exit
      if (position && istMin >= FORCED_EXIT_MIN) {
        closePos(position, c.close, c.time, "EOD square-off (15:15)");
        trades.push(buildTradeRecord(position));
        position = null; continue;
      }

      // In-position exits
      if (position) {
        // Spot SL (opposite side of OR)
        if (position.side === "CE" && c.low <= position.slSpot) {
          closePos(position, position.slSpot, c.time, `Spot SL hit (${position.slSpot} = ORL)`);
          trades.push(buildTradeRecord(position));
          position = null; continue;
        }
        if (position.side === "PE" && c.high >= position.slSpot) {
          closePos(position, position.slSpot, c.time, `Spot SL hit (${position.slSpot} = ORH)`);
          trades.push(buildTradeRecord(position));
          position = null; continue;
        }
        // Spot target (1.5× range)
        if (position.side === "CE" && c.high >= position.targetSpot) {
          closePos(position, position.targetSpot, c.time, `Spot target hit (${position.targetSpot})`);
          trades.push(buildTradeRecord(position));
          position = null; continue;
        }
        if (position.side === "PE" && c.low <= position.targetSpot) {
          closePos(position, position.targetSpot, c.time, `Spot target hit (${position.targetSpot})`);
          trades.push(buildTradeRecord(position));
          position = null; continue;
        }
        // Premium target / SL approximated
        const candlesHeld = ((c.time - position.entryTime) / 60) / 5;
        const thetaCost = (THETA_DAY * candlesHeld) / 78;
        const spotMove = position.side === "CE" ? (c.close - position.entrySpot) : (position.entrySpot - c.close);
        const approxPrem = Math.max(0.05, position.optionEntryLtp + spotMove * DELTA - thetaCost / LOT_SIZE);
        if (approxPrem <= position.stopPremium) {
          closePos(position, c.close, c.time, `Premium SL (~₹${approxPrem.toFixed(1)} <= ₹${position.stopPremium})`);
          trades.push(buildTradeRecord(position));
          position = null; continue;
        }
        if (approxPrem >= position.targetPremium) {
          closePos(position, c.close, c.time, `Premium target (~₹${approxPrem.toFixed(1)} >= ₹${position.targetPremium})`);
          trades.push(buildTradeRecord(position));
          position = null; continue;
        }
      }

      // Flat → eval ORB signal
      if (!position && tradesTaken < maxTrades && istMin < ENTRY_END_MIN) {
        const seen = dayCandles.slice(0, i + 1);
        const sig  = orbStrategy.getSignal(seen, { silent: true, alreadyTraded: false });
        if (sig.signal === "BUY_CE" || sig.signal === "BUY_PE") {
          position = {
            date: istDateOf(c.time),
            side: sig.side,
            entryTime: c.time,
            entrySpot: c.close,
            optionEntryLtp: SEED_PREMIUM,
            orh: sig.orh, orl: sig.orl, rangePts: sig.rangePts,
            slSpot: sig.slSpot, targetSpot: sig.targetSpot,
            targetPremium: parseFloat((SEED_PREMIUM * (1 + TARGET_PCT)).toFixed(2)),
            stopPremium:   parseFloat((SEED_PREMIUM * (1 - STOP_PCT)).toFixed(2)),
            signalStrength: sig.signalStrength,
            entryReason: sig.reason,
          };
          tradesTaken++;
        }
      }
    }
    if (position) {
      const last = dayCandles[dayCandles.length - 1];
      closePos(position, last.close, last.time, "EOD (end of day candles)");
      trades.push(buildTradeRecord(position));
    }
  }

  function closePos(pos, exitSpot, exitTime, reason) {
    const candlesHeld = ((exitTime - pos.entryTime) / 60) / 5;
    const thetaCost = (THETA_DAY * candlesHeld) / 78;
    const spotMove = pos.side === "CE" ? (exitSpot - pos.entrySpot) : (pos.entrySpot - exitSpot);
    const exitPrem = Math.max(0.05, pos.optionEntryLtp + spotMove * DELTA - thetaCost / LOT_SIZE);
    const charges = getCharges({ broker: "fyers", isFutures: false, entryPremium: pos.optionEntryLtp, exitPremium: exitPrem, qty: LOT_SIZE });
    const pnl = parseFloat(((exitPrem - pos.optionEntryLtp) * LOT_SIZE - charges).toFixed(2));
    pos.exitTime = exitTime;
    pos.exitSpot = exitSpot;
    pos.optionExitLtp = parseFloat(exitPrem.toFixed(2));
    pos.exitReason = reason;
    pos.pnl = pnl;
    pos.heldCandles = Math.round(candlesHeld);
  }

  function buildTradeRecord(p) {
    return {
      side: p.side,
      entry: entryTsStr(p.entryTime),
      exit:  entryTsStr(p.exitTime),
      entryTs: p.entryTime, exitTs: p.exitTime,
      ePrice: p.entrySpot, xPrice: p.exitSpot, sl: p.slSpot,
      pnl: p.pnl,
      reason: p.exitReason,
      entryReason: p.entryReason,
      // ORB-specific
      orh: p.orh, orl: p.orl, rangePts: p.rangePts,
      strength: p.signalStrength,
      eOpt: p.optionEntryLtp, xOpt: p.optionExitLtp,
      held: p.heldCandles,
    };
  }

  return trades;
}

// ── Routes ──────────────────────────────────────────────────────────────────

// /idle is polled by /all-backtest to detect when the synchronous backtest finishes.
router.get("/idle", (req, res) => {
  if (req.accepts(["json", "html"]) === "json" || req.query.json === "1") {
    return res.json({ idle: !_inflight });
  }
  return res.redirect("/orb-backtest");
});

router.get("/", async (req, res) => {
  let { from, to } = req.query;
  // No params → default to last 30 days so the page always renders the full
  // results layout (matches scalp/PA backtest behaviour — no separate idle UI).
  if (!from || !to) {
    const today = new Date();
    const def30 = new Date(); def30.setDate(today.getDate() - 30);
    const fmt = d => d.toISOString().slice(0, 10);
    return res.redirect(`/orb-backtest?from=${fmt(def30)}&to=${fmt(today)}`);
  }
  _inflight = true;
  try {
    console.log(`🔍 ORB Backtest: ${from} → ${to}`);
    const candles = await fetchCandlesCachedBT(NIFTY_INDEX_SYMBOL, "5", from, to, false);
    const trades = runOrbBacktest(candles || []);
    const stats = computeBacktestStats(trades);
    // P&L is computed in ₹ (premium × LOT_SIZE − charges). Mark the result
    // so /all-backtest renders it as ₹ instead of "pts".
    stats.optionSim   = true;
    stats.delta       = parseFloat(process.env.BACKTEST_DELTA     || "0.55");
    stats.thetaPerDay = parseFloat(process.env.BACKTEST_THETA_DAY || "8");

    // Save for /all-backtest dashboard
    try {
      saveResult(RESULT_KEY, { summary: stats, params: { from, to, resolution: "5" } });
    } catch (e) { console.warn("[orb-backtest] saveResult failed:", e.message); }

    const html = renderBacktestResults({
      mode: "ORB",
      accent: ACCENT,
      strategyName: orbStrategy.NAME,
      endpoint: ENDPOINT,
      from, to,
      summary: stats,
      trades,
      activePage: "orbBacktest",
      extraTradeColumns: [
        { key: "rangePts", label: "Range (pt)" },
        { key: "strength", label: "Sig" },
      ],
      extraStats: [
        { label: "Avg OR Range", value: trades.length ? `${Math.round(trades.reduce((a, t) => a + (t.rangePts || 0), 0) / trades.length)}pt` : "—" },
        { label: "STRONG Signals", value: trades.filter(t => t.strength === "STRONG").length },
        { label: "Avg Held Candles", value: trades.length ? Math.round(trades.reduce((a, t) => a + (t.held || 0), 0) / trades.length) : "—" },
      ],
      notes: "Premium is approximated using δ + θ from historical NIFTY 5-min candles (no live option chain in backtest). Treat absolute ₹ figures as directional only.",
    });
    res.send(html);
  } catch (err) {
    console.error("[orb-backtest] error:", err);
    res.status(500).send(renderErrorPage(err.message, from, to));
  } finally {
    _inflight = false;
  }
});

function renderIdleForm() {
  const liveActive = sharedSocketState.getMode() === "SWING_LIVE";
  const today = new Date().toISOString().slice(0, 10);
  const def30 = (() => { const d = new Date(); d.setDate(d.getDate() - 30); return d.toISOString().slice(0, 10); })();
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"/>${faviconLink()}<title>ORB Backtest</title>
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
.preset-btn{font-size:0.65rem;padding:4px 12px;border-radius:4px;background:rgba(16,185,129,0.08);color:${ACCENT};border:0.5px solid rgba(16,185,129,0.2);cursor:pointer;font-family:inherit;}
.preset-btn:hover{background:rgba(16,185,129,0.18);}
.notes{margin-top:18px;font-size:0.72rem;color:#94a3b8;background:#08091a;border:0.5px solid #0e1428;border-radius:8px;padding:14px 16px;}
</style></head><body>
<div class="app-shell">
${buildSidebar('orbBacktest', liveActive)}
<main class="main">
  <div class="title">🔍 ORB Backtest</div>
  <div class="sub">Opening Range Breakout (15-min OR, 5-min confirm) — date-range historical backtest with delta + theta option premium simulation.</div>
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
    <b>Backtest sim model:</b> Option premium estimated via δ (BACKTEST_DELTA, default 0.55) + θ (BACKTEST_THETA_DAY, default ₹8/day) seeded at ₹${process.env.ORB_BT_SEED_PREMIUM || "180"} per side. Exits mirror the paper-trade route exactly: spot SL = opposite OR edge, spot target = 1.5× range, premium SL/target = ±30%/+50%. Use Replay (recorded ticks) for tick-accurate backtests.
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
  window.location='/orb-backtest?from='+p2[0]+'&to='+p2[1];
}
</script>
</div></body></html>`;
}

function renderErrorPage(msg, from, to) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"/>${faviconLink()}<title>ORB Backtest Error</title>
<style>body{font-family:'IBM Plex Mono',monospace;background:#060810;color:#a0b8d8;padding:40px;text-align:center;}
h2{color:#ef4444;margin-bottom:12px;}p{margin-bottom:18px;}
a{color:${ACCENT};text-decoration:none;border:0.5px solid #0e1428;padding:8px 14px;border-radius:6px;}</style>
</head><body><h2>ORB Backtest Failed</h2><p>${msg}</p><p><b>${from || ""}</b> → <b>${to || ""}</b></p><a href="/orb-backtest">← Back</a></body></html>`;
}

module.exports = router;

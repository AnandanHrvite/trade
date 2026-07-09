/**
 * ORB BACKTEST — /orb-backtest
 * ─────────────────────────────────────────────────────────────────────────────
 * Date-range backtest of the Opening Range Breakout strategy. Reuses the
 * shared backtest UI helper for full parity with bb_rsi/PA backtest pages.
 *
 * Endpoints:
 *   GET /orb-backtest                → form (no params)
 *   GET /orb-backtest?from=&to=      → run + render results
 *   GET /orb-backtest/idle           → idle landing
 * ─────────────────────────────────────────────────────────────────────────────
 */

const express = require("express");
const router  = express.Router();
const { EMA } = require("technicalindicators");
const orbStrategy = require("../strategies/orb_breakout");
const { fetchCandlesCachedBT } = require("../services/backtestEngine");
const { buildSidebar, sidebarCSS, faviconLink } = require("../utils/sharedNav");
const sharedSocketState = require("../utils/sharedSocketState");
const { getCharges } = require("../utils/charges");
const { renderBacktestResults, computeBacktestStats } = require("../utils/backtestUI");
const { saveResult } = require("../utils/resultStore");
const { isExpiryDate } = require("../utils/nseHolidays");
const backtestJobs = require("../utils/backtestJobManager");
const instrumentConfig = require("../config/instrument");

const NIFTY_INDEX_SYMBOL = "NSE:NIFTY50-INDEX";
const ACCENT = "#10b981";
const ENDPOINT = "/orb-backtest";
const RESULT_KEY = "ORB_BACKTEST";


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

// EMA of candle closes up to (and including) index `uptoIdx`. Returns null until
// `period` closes exist. Mirrors the paper/live EMA trend-trail (technicalindicators).
function _emaOfCloses(candles, uptoIdx, period) {
  if (uptoIdx + 1 < period) return null;
  const closes = [];
  for (let k = 0; k <= uptoIdx; k++) closes.push(candles[k].close);
  const arr = EMA.calculate({ period, values: closes });
  return arr && arr.length ? arr[arr.length - 1] : null;
}

function runOrbBacktest(allCandles, expirySet) {
  if (!allCandles || !allCandles.length) return [];

  const EXPIRY_ONLY = (process.env.ORB_EXPIRY_DAY_ONLY || "false").toLowerCase() === "true";
  const DELTA      = parseFloat(process.env.BACKTEST_DELTA || "0.55");
  const THETA_DAY  = parseFloat(process.env.BACKTEST_THETA_DAY || "8");
  // Use the same lot-qty helper as paper/live so LOT_MULTIPLIER and
  // NIFTY_LOT_SIZE flow through end-to-end (lot qty = NIFTY_LOT_SIZE × LOT_MULTIPLIER).
  const LOT_SIZE   = instrumentConfig.getLotQty();
  // Trend-following exit (mirrors paper/live): initial hard SL = breakout candle
  // low/high, breakeven after +N pts, EMA close-trail, strong-opposite-candle
  // exit, per-trade rupee loss cap, 15:15 EOD. (Replaced the old 2-candle swing
  // trail that exited winners on the first pullback.)
  const TRAIL_EMA      = Math.max(2, parseInt(process.env.ORB_TRAIL_EMA || "20", 10));
  const BE_PTS         = parseFloat(process.env.ORB_BREAKEVEN_PTS || "20");
  const OPP_ON         = (process.env.ORB_OPP_CANDLE_EXIT || "true").toLowerCase() === "true";
  const OPP_MULT       = parseFloat(process.env.ORB_OPP_CANDLE_BODY_MULT || "0.3");
  const MAX_TRADE_LOSS = parseFloat(process.env.ORB_MAX_TRADE_LOSS || "1500");
  const PREM_GATE_ON = (process.env.ORB_PREMIUM_GATE_ENABLED || "true").toLowerCase() === "true";
  const PREM_MIN     = parseFloat(process.env.ORB_PREMIUM_MIN || "80");
  const PREM_MAX     = parseFloat(process.env.ORB_PREMIUM_MAX || "250");
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
    if (EXPIRY_ONLY && expirySet && !expirySet.has(_dateStr)) continue;
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

      // In-position management (mirrors paper _managePositionOnClose + _checkExits):
      //   strong-opposite-candle → breakeven → EMA close-trail → per-trade loss
      //   cap → hard-SL breach. All evaluated on the current candle.
      if (position) {
        const _bodyPts = Math.abs(c.close - c.open);
        // 1. strong opposite reversal candle
        const _oppThresh = OPP_MULT * (position.rangePts || 0);
        if (OPP_ON && _oppThresh > 0 && _bodyPts >= _oppThresh &&
            ((position.side === "CE" && c.close < c.open && c.close < position.orh) ||
             (position.side === "PE" && c.close > c.open && c.close > position.orl))) {
          closePos(position, c.close, c.time, `Strong opposite candle (body ${_bodyPts.toFixed(1)}pt)`);
          trades.push(buildTradeRecord(position)); position = null; continue;
        }
        // 2. breakeven — lift hard SL to entry once far enough in profit
        const _favPts = (c.close - position.entrySpot) * (position.side === "CE" ? 1 : -1);
        if (!position.breakevenArmed && BE_PTS > 0 && _favPts >= BE_PTS) {
          if (position.side === "CE" && position.entrySpot > position.slSpot) position.slSpot = position.entrySpot;
          if (position.side === "PE" && position.entrySpot < position.slSpot) position.slSpot = position.entrySpot;
          position.breakevenArmed = true;
        }
        // 3. EMA close-trail — exit only when THIS candle closes back across the
        //    EMA, and only after price first closed on the correct side (emaArmed)
        //    so a gap-day entry below a stale EMA isn't stopped out on candle 1.
        const _ema = _emaOfCloses(dayCandles, i, TRAIL_EMA);
        if (_ema != null) {
          if (position.side === "CE") {
            if (c.close >= _ema) position.emaArmed = true;
            else if (position.emaArmed) { closePos(position, c.close, c.time, `Closed below EMA${TRAIL_EMA}`); trades.push(buildTradeRecord(position)); position = null; continue; }
          } else {
            if (c.close <= _ema) position.emaArmed = true;
            else if (position.emaArmed) { closePos(position, c.close, c.time, `Closed above EMA${TRAIL_EMA}`); trades.push(buildTradeRecord(position)); position = null; continue; }
          }
        }
        // 4. per-trade loss cap (worst-case sim premium within this candle)
        if (MAX_TRADE_LOSS > 0) {
          const _spotMove = position.side === "CE" ? (c.low - position.entrySpot) : (position.entrySpot - c.high);
          const _curPrem  = Math.max(0.05, position.optionEntryLtp + _spotMove * DELTA);
          if ((_curPrem - position.optionEntryLtp) * LOT_SIZE <= -MAX_TRADE_LOSS) {
            closePos(position, position.side === "CE" ? c.low : c.high, c.time, `Max trade loss (₹${MAX_TRADE_LOSS})`);
            trades.push(buildTradeRecord(position)); position = null; continue;
          }
        }
        // 5. hard SL breach against this candle's extreme
        if (position.side === "CE" && c.low <= position.slSpot) {
          closePos(position, position.slSpot, c.time, `Hard SL hit (${position.slSpot})`);
          trades.push(buildTradeRecord(position)); position = null; continue;
        }
        if (position.side === "PE" && c.high >= position.slSpot) {
          closePos(position, position.slSpot, c.time, `Hard SL hit (${position.slSpot})`);
          trades.push(buildTradeRecord(position)); position = null; continue;
        }
      }

      // Flat → eval ORB signal
      if (!position && tradesTaken < maxTrades && istMin < ENTRY_END_MIN) {
        const seen = dayCandles.slice(0, i + 1);
        const sig  = orbStrategy.getSignal(seen, { silent: true, alreadyTraded: false });
        if (sig.signal === "BUY_CE" || sig.signal === "BUY_PE") {
          // Premium-range gate — backtest uses SEED_PREMIUM as the entry-premium
          // proxy, so this gate is effectively a config sanity check (will skip
          // every trade if SEED_PREMIUM lies outside the band).
          if (PREM_GATE_ON && (SEED_PREMIUM < PREM_MIN || SEED_PREMIUM > PREM_MAX)) {
            continue;
          }
          // Initial hard SL = the breakout candle's own low (CE) / high (PE).
          const initSl = sig.side === "CE"
            ? Math.round(c.low  * 100) / 100
            : Math.round(c.high * 100) / 100;
          position = {
            date: istDateOf(c.time),
            side: sig.side,
            entryTime: c.time,
            entrySpot: c.close,
            optionEntryLtp: SEED_PREMIUM,
            orh: sig.orh, orl: sig.orl, rangePts: sig.rangePts,
            slSpot: initSl, targetSpot: sig.targetSpot,
            breakevenArmed: false, emaArmed: false,
            signalStrength: sig.signalStrength,
            vwap: sig.vwap, volRatio: sig.volRatio, wickRatio: sig.wickRatio,
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
// Poll endpoint for the progress page (mirrors EMA_RSI_ST backtest).
router.get("/status", (req, res) => {
  const job = backtestJobs.getJob(req.query.jobId);
  if (!job) return res.json({ status: "not_found" });
  res.json({ status: job.status, progress: job.progress, elapsed: Date.now() - job.startedAt, error: job.error });
});

router.get("/idle", (req, res) => {
  if (req.accepts(["json", "html"]) === "json" || req.query.json === "1") {
    return res.json({ idle: backtestJobs.isIdle() });
  }
  return res.redirect("/orb-backtest");
});

// Rendered trade-log / stats helper — shared by the completed-job branch.
function _renderOrbResults(res, from, to, trades, stats) {
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
}

router.get("/", async (req, res) => {
  let { from, to } = req.query;
  // No params → default to last 30 days so the page always renders the full
  // results layout (matches bb_rsi/PA backtest behaviour — no separate idle UI).
  if (!from || !to) {
    const today = new Date();
    const def30 = new Date(); def30.setDate(today.getDate() - 30);
    const fmt = d => d.toISOString().slice(0, 10);
    return res.redirect(`/orb-backtest?from=${fmt(def30)}&to=${fmt(today)}`);
  }

  // ── Background job system ──────────────────────────────────────────────────
  // The fetch chunks the range into months (350ms rate-limit sleep + retries per
  // month), so a multi-year range takes minutes — far past an HTTP timeout if run
  // synchronously (which returned an empty candle set → 0 trades). Run it as a
  // background job with progress polling, exactly like the EMA_RSI_ST backtest.
  const jobId = req.query.jobId;

  if (!jobId) {
    const activeJob = backtestJobs.getActiveJob();
    if (activeJob) return res.send(backtestJobs.buildQueuePage(ENDPOINT, "ORB Backtest"));

    const { id } = backtestJobs.createJob("orb");

    (async () => {
      try {
        console.log(`🔍 ORB Backtest job ${id}: ${from} → ${to}`);
        backtestJobs.updateProgress(id, { phase: "Fetching candle data…", pct: 0 });
        const _onFetchProgress = (p) => backtestJobs.updateProgress(id, p);
        const candles = await fetchCandlesCachedBT(NIFTY_INDEX_SYMBOL, "5", from, to, false, _onFetchProgress);

        if (!Array.isArray(candles) || candles.length < 5) {
          // Distinguish "Fyers had no data for this range" (0 candles — future dates,
          // beyond available history, or a token/entitlement gap) from a genuinely
          // narrow range (a handful of candles). The old message told the user to
          // "widen the range" even when they'd asked for a whole month and Fyers
          // simply returned nothing — misleading. Real reason is in the server logs
          // (fetchChunk logs the Fyers getHistory response).
          const n = Array.isArray(candles) ? candles.length : 0;
          const msg = n === 0
            ? `Fyers returned no historical candles for ${from} → ${to}. That range may be in the future or beyond available history, or the Fyers token can't serve NIFTY index history. Try an earlier range known to have data, and check the server logs for the getHistory response.`
            : `Only ${n} candle(s) for ${from} → ${to} — the range is too narrow. Widen it to at least a week of trading days.`;
          backtestJobs.failJob(id, msg);
          return;
        }

        // Pre-compute expiry-day set if ORB_EXPIRY_DAY_ONLY is on
        let expirySet = null;
        if ((process.env.ORB_EXPIRY_DAY_ONLY || "false").toLowerCase() === "true") {
          const uniqueDates = new Set();
          for (const c of candles) {
            const d = new Date((c.time + 19800) * 1000);
            uniqueDates.add(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`);
          }
          expirySet = new Set();
          for (const dt of uniqueDates) {
            try { if (await isExpiryDate(dt)) expirySet.add(dt); } catch (_) {}
          }
          console.log(`📅 ORB expiry-only: ${expirySet.size}/${uniqueDates.size} trading days qualified`);
        }

        backtestJobs.updateProgress(id, { phase: `Running ORB backtest (${candles.length.toLocaleString()} candles)…`, pct: 5 });
        const trades = runOrbBacktest(candles, expirySet);
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

        backtestJobs.completeJob(id, { trades, stats, from, to });
        console.log(`✅ ORB Backtest job ${id} complete — ${trades.length} trades`);
      } catch (err) {
        console.error("[orb-backtest] job error:", err);
        backtestJobs.failJob(id, err.message);
      }
    })();

    return res.send(backtestJobs.buildProgressPage(id, ENDPOINT, "ORB Backtest"));
  }

  // ── Render completed job ───────────────────────────────────────────────────
  const job = backtestJobs.getJob(jobId);
  if (!job) return res.redirect(ENDPOINT);
  if (job.status === "running") return res.send(backtestJobs.buildProgressPage(jobId, ENDPOINT, "ORB Backtest"));
  if (job.status === "error")   return res.status(500).send(renderErrorPage(job.error, from, to));

  const { trades, stats } = job.result;
  return _renderOrbResults(res, from, to, trades, stats);
});

function renderIdleForm() {
  const liveActive = sharedSocketState.getMode() === "EMA_RSI_ST_LIVE";
  const today = new Date().toISOString().slice(0, 10);
  const def30 = (() => { const d = new Date(); d.setDate(d.getDate() - 30); return d.toISOString().slice(0, 10); })();
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>${faviconLink()}<title>ORB Backtest</title>
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
    <b>Backtest sim model:</b> Option premium estimated via δ (BACKTEST_DELTA, default 0.55) + θ (BACKTEST_THETA_DAY, default ₹8/day) seeded at ₹${process.env.ORB_BT_SEED_PREMIUM || "180"} per side. Qty per trade = ${instrumentConfig.getLotQty()} (= NIFTY_LOT_SIZE ${process.env.NIFTY_LOT_SIZE || "65"} × LOT_MULTIPLIER ${process.env.LOT_MULTIPLIER || "1"}). Exits mirror the paper-trade route: initial hard SL = breakout candle low/high, breakeven after +${process.env.ORB_BREAKEVEN_PTS || "20"}pt, EMA${process.env.ORB_TRAIL_EMA || "20"} close-trail (exit only when a candle closes back across the EMA), strong-opposite-candle exit, a ₹${process.env.ORB_MAX_TRADE_LOSS || "1500"} per-trade loss cap, and a 15:15 EOD square-off. Entry requires the close to clear the OR edge by a buffer (max(${process.env.ORB_BREAKOUT_BUFFER_MIN || "8"}pt, ${process.env.ORB_BREAKOUT_BUFFER_PCT || "0.15"}×range)). Filters (VWAP / volume / wick-ratio / premium-range) are read from env. Use Replay (recorded ticks) for tick-accurate backtests.
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
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>${faviconLink()}<title>ORB Backtest Error</title>
<style>body{font-family:'IBM Plex Mono',monospace;background:#060810;color:#a0b8d8;padding:40px;text-align:center;}
h2{color:#ef4444;margin-bottom:12px;}p{margin-bottom:18px;}
a{color:${ACCENT};text-decoration:none;border:0.5px solid #0e1428;padding:8px 14px;border-radius:6px;}</style>
</head><body><h2>ORB Backtest Failed</h2><p>${msg}</p><p><b>${from || ""}</b> → <b>${to || ""}</b></p><a href="/orb-backtest">← Back</a></body></html>`;
}

module.exports = router;

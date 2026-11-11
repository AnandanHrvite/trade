/**
 * ITM20 SCALP BACKTEST — /itm20-scalp-backtest
 * ─────────────────────────────────────────────────────────────────────────────
 * Date-range backtest on 5-minute NIFTY 50 INDEX spot candles. Entries, the
 * strike rule, the premium stop / target and the day limits all come from the
 * SAME engine the paper route uses (src/strategies/itm20_scalp.js). This file
 * only walks bars and re-implements paper's exits on bar data.
 *
 *   for each closed bar (until the day is closed):
 *     getSignal(yesterday + today up to this bar, resumeAfterSec = last exit)
 *   fill: the NEXT bar's OPEN (paper fills on the first quote after the close)
 *   exit, per bar, conservative order:
 *     open   — a bar that opens through the stop fills at the open (worse);
 *              one that opens through the target fills AT the target
 *     adverse extreme — stop (incl. daily-loss cap / common premium stop)
 *     favourable extreme — target
 *     close  — common profit lock given back inside the bar
 *     square-off — the bar that closes at 15:15 exits at its close
 *   A bar that touches both stop and target is a STOP (adverse leg first).
 *
 * There is NO historical option chain: premium is δ+θ simulated from the
 * spot path, seeded at BACKTEST_SEED_PREMIUM, with BACKTEST_SLIPPAGE_PTS each
 * way and full charges (brokerage, STT, exchange, GST, stamp duty) per trade —
 * the same model every other backtest here uses. Treat ₹ as DIRECTIONAL.
 */

const express = require("express");
const router  = express.Router();
const strat = require("../strategies/itm20_scalp");
const { fetchCandlesCachedBT } = require("../services/backtestEngine");
const { fyersErrText } = require("../utils/fyersErr");
const { faviconLink } = require("../utils/sharedNav");
const { getCharges } = require("../utils/charges");
const { renderBacktestResults, computeBacktestStats } = require("../utils/backtestUI");
const { saveResult } = require("../utils/resultStore");
const backtestJobs = require("../utils/backtestJobManager");
const instrumentConfig = require("../config/instrument");
const tradeGuards = require("../utils/tradeGuards");
const backtestCosts = require("../config/backtestCosts");
const nseHolidays = require("../utils/nseHolidays");

const ACCENT = "#22d3ee";
const ENDPOINT = "/itm20-scalp-backtest";
const RESULT_KEY = "ITM20_SCALP_BACKTEST";
const LOG = "[ITM20-SCALP-BACKTEST]";
const SPOT_SYMBOL = "NSE:NIFTY50-INDEX";
const RES = strat.RESOLUTION_MIN;

function istDateOf(unixSec) {
  const d = new Date((unixSec + 19800) * 1000);
  return `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${d.getUTCFullYear()}`;
}
function istHHMMSS(unixSec) {
  const d = new Date((unixSec + 19800) * 1000);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}:${String(d.getUTCSeconds()).padStart(2, "0")}`;
}
function entryTsStr(unixSec) { return `${istDateOf(unixSec)}, ${istHHMMSS(unixSec)}`; }
function escHtml(x) {
  return String(x == null ? "" : x).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function _r2(x) { return Math.round(x * 100) / 100; }

function _warmupDays() {
  const v = parseInt(process.env.ITM20_SCALP_WARMUP_DAYS, 10);
  return Number.isFinite(v) && v >= 2 && v <= 30 ? v : 7;
}
function shiftDateStr(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  if (isNaN(d.getTime())) return dateStr;
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}
function warmupRange(from, to) {
  return { fetchFrom: shiftDateStr(from, _warmupDays()), fetchTo: to, warmupDays: _warmupDays() };
}

// ── The backtest ─────────────────────────────────────────────────────────────
/**
 * @param {Array}  intraday  5-min NIFTY spot candles, ascending, INCLUDING the warm-up runway
 * @param {string} rangeFrom "YYYY-MM-DD" IST — the first day a trade may open
 * @param {object} [opts]    { cfg, lock, isExpiryDate: async (dateStr) => bool } — test hooks
 */
async function runItm20ScalpBacktest(intraday, rangeFrom, opts) {
  const o = opts || {};
  const funnel = {
    days: 0, warmup: 0, incompleteOr: 0, expirySkipped: 0, breakouts: 0, signals: 0, entries: 0,
    noTradeDays: 0, targetDays: 0,
  };
  const empty = { trades: [], days: 0, skipped: [], funnel, exitReasons: {}, dayStops: {} };
  if (!Array.isArray(intraday) || !intraday.length) return empty;

  const cfg = o.cfg || strat.getConfig();
  const isExpiryDate = o.isExpiryDate || nseHolidays.isExpiryDate;
  const DELTA        = parseFloat(process.env.BACKTEST_DELTA || "0.55");
  const THETA_DAY    = parseFloat(process.env.BACKTEST_THETA_DAY || "8");
  const LOT_SIZE     = instrumentConfig.getLotQty();
  const SEED_PREMIUM = backtestCosts.seedPremium();
  const SLIPPAGE_PTS = backtestCosts.slippagePts();
  const STEP         = instrumentConfig.underlyingOf().strikeStep;
  const _REENTRY_COOLDOWN_SECS = tradeGuards.reentryCooldownMs(RES) / 1000;
  const lock = o.lock || {
    enabled: tradeGuards.PROFIT_LOCK_ENABLED,
    armPct: tradeGuards.PROFIT_LOCK_ARM_PCT,
    floorPct: tradeGuards.PROFIT_LOCK_FLOOR_PCT,
    trailPct: tradeGuards.PROFIT_LOCK_TRAIL_PCT,
  };
  const lockOpts = { enabled: !!lock.enabled, armPct: lock.armPct, floorPct: lock.floorPct, trailPct: lock.trailPct };
  if (o.lock && o.lock.slEnabled != null) lockOpts.slEnabled = !!o.lock.slEnabled;

  const sorted = intraday.filter(c => c && typeof c.time === "number").sort((a, b) => a.time - b.time);
  const dayKeys = [];
  const byDay = new Map();
  for (let i = 0; i < sorted.length; i++) {
    const k = strat._istDayOf(sorted[i].time);
    if (!byDay.has(k)) { byDay.set(k, []); dayKeys.push(k); }
    byDay.get(k).push(i);
  }

  const trades = [];
  const skipped = [];
  const exitReasons = {};
  const dayStops = {};
  const barsPerDay = Math.max(1, Math.round(375 / RES));

  for (let d = 0; d < dayKeys.length; d++) {
    await new Promise(resolve => setImmediate(resolve));
    const k = dayKeys[d];
    const idxs = byDay.get(k);
    const dayTs = sorted[idxs[0]].time;
    const dayStr = strat._istDateStr(dayTs);
    if (rangeFrom && dayStr < rangeFrom) continue;
    funnel.days++;

    let expiry = false;
    try { expiry = !!(await isExpiryDate(dayStr)); } catch (_) { expiry = false; }
    if (expiry && !cfg.tradeExpiryDay) {
      funnel.expirySkipped++; funnel.noTradeDays++;
      skipped.push({ date: istDateOf(dayTs), reason: "weekly expiry day — skipped" });
      continue;
    }

    const winStart = d > 0 ? byDay.get(dayKeys[d - 1])[0] : idxs[0];
    const dayTrades = [];     // { points } — fed to the engine's day gate
    let pos = null;
    let pending = null;
    let lastExitSec = null;
    let reentryBlockUntil = 0;
    let dayClosed = false;
    let dayNote = null;
    let sawBreakout = false;

    function premAt(spotPx, t) {
      const barsHeld = Math.max(0, (t - pos.entryTime) / 60 / RES);
      const thetaCost = (THETA_DAY * barsHeld) / barsPerDay;
      const move = pos.side === "CE" ? (spotPx - pos.entrySpot) : (pos.entrySpot - spotPx);
      return Math.max(0.05, pos.optionEntryLtp + move * DELTA - thetaCost / LOT_SIZE);
    }
    /** Spot that maps to premium `p` at time t (inverse of premAt). */
    function spotFor(p, t) {
      const barsHeld = Math.max(0, (t - pos.entryTime) / 60 / RES);
      const thetaCost = (THETA_DAY * barsHeld) / barsPerDay;
      const move = (p - pos.optionEntryLtp + thetaCost / LOT_SIZE) / DELTA;
      return pos.side === "CE" ? pos.entrySpot + move : pos.entrySpot - move;
    }
    function close(rawPrem, exitTime, reason, code, atBarClose) {
      const exitPrem = _r2(Math.max(0.05, rawPrem - 2 * SLIPPAGE_PTS));
      const points = _r2(exitPrem - pos.optionEntryLtp);
      const gross = _r2(points * LOT_SIZE);
      const charges = getCharges({ broker: "zerodha", isFutures: false, entryPremium: pos.optionEntryLtp, exitPremium: exitPrem, qty: LOT_SIZE });
      const pnl = _r2(gross - charges);
      exitReasons[code] = (exitReasons[code] || 0) + 1;
      const exitSec = exitTime + (atBarClose ? RES * 60 : 0);
      trades.push({
        side: pos.side,
        entry: entryTsStr(pos.entryTime), exit: entryTsStr(exitSec),
        entryTs: pos.entryTime, exitTs: exitSec,
        ePrice: pos.entrySpot, xPrice: _r2(spotFor(rawPrem, exitTime)),
        sl: pos.stopPrem, target: pos.targetPrem,
        strike: pos.strike,
        orHigh: pos.orHigh, orLow: pos.orLow, vwap: pos.vwap, ema: pos.ema,
        breakout: pos.breakoutTime ? istHHMMSS(pos.breakoutTime).slice(0, 5) : null,
        retest: pos.retestTime ? istHHMMSS(pos.retestTime).slice(0, 5) : null,
        exitCode: code,
        points, grossPnl: gross, charges,
        pnl, reason, entryReason: pos.entryReason,
        strength: "STRONG",
        eOpt: pos.optionEntryLtp, xOpt: exitPrem,
        held: Math.round(Math.max(0, (exitSec - pos.entryTime) / 60 / RES)),
      });
      dayTrades.push({ points });
      lastExitSec = exitSec;
      pos = null;
      if (_REENTRY_COOLDOWN_SECS > 0) reentryBlockUntil = exitSec + _REENTRY_COOLDOWN_SECS;
      const g = strat.dayRiskGate(dayTrades, cfg);
      if (!g.allowed) { dayClosed = true; dayStops[g.status] = (dayStops[g.status] || 0) + 1; dayNote = g.reason; }
    }

    /** One bar of an open position — paper's exits, conservative order. */
    function manage(c) {
      const isCE = pos.side === "CE";
      const entry = pos.optionEntryLtp;
      const pOpen = premAt(c.open, c.time);
      // Common guards' level (profit lock floor / premium SL) — null when both are off.
      const commonLvl = tradeGuards.exitLevelLtp(entry, pos.peakPrem, lockOpts);
      const stopLvl = commonLvl != null && commonLvl > pos.stopPrem ? commonLvl : pos.stopPrem;
      const stopCode = commonLvl != null && commonLvl > pos.stopPrem ? "PROFIT_LOCK" : pos.stopKind;
      const stopTxt = stopCode === "PROFIT_LOCK" ? `Common profit lock / premium stop ₹${_r2(stopLvl)}`
        : stopCode === "DAILY_LOSS" ? `Daily loss cap stop ₹${pos.stopPrem}` : `Stop-loss −${cfg.slPts} at ₹${pos.stopPrem}`;

      if (pOpen <= stopLvl) { close(pOpen, c.time, `${stopTxt} (bar opened through it — filled at the open)`, stopCode); return; }
      if (pOpen >= pos.targetPrem) { close(pos.targetPrem, c.time, `Target +${cfg.targetPts} at ₹${pos.targetPrem} (bar opened beyond it — filled at the target)`, "TARGET"); return; }
      if (pOpen > pos.peakPrem) pos.peakPrem = pOpen;

      const pAdv = premAt(isCE ? c.low : c.high, c.time);
      if (pAdv <= stopLvl) { close(Math.min(pOpen, stopLvl), c.time, stopTxt, stopCode); return; }

      const pFav = premAt(isCE ? c.high : c.low, c.time);
      if (pFav >= pos.targetPrem) { close(pos.targetPrem, c.time, `Target +${cfg.targetPts} at ₹${pos.targetPrem}`, "TARGET"); return; }
      if (pFav > pos.peakPrem) pos.peakPrem = pFav;

      const pClose = premAt(c.close, c.time);
      const msg = tradeGuards.checkProfitLock(entry, pClose, pos.peakPrem, lockOpts);
      if (msg) { close(pClose, c.time, `${msg} (given back inside the bar — filled at the close)`, "PROFIT_LOCK", true); return; }

      const closeMin = strat._utcSecToIstMins(c.time) + RES;
      if (closeMin >= cfg.squareOffMin) close(pClose, c.time, `Square-off ${strat._fmtMins(cfg.squareOffMin)}`, "SQUARE_OFF", true);
    }

    for (let j = 0; j < idxs.length; j++) {
      const gi = idxs[j];
      const c = sorted[gi];
      const startMin = strat._utcSecToIstMins(c.time);

      // 1. Fill a pending entry at THIS bar's open.
      if (pending && !pos) {
        const sig = pending;
        pending = null;
        if (typeof c.open === "number" && Number.isFinite(c.open) && startMin < cfg.squareOffMin) {
          const gate = strat.dayRiskGate(dayTrades, cfg);
          const stp = strat.stopLevel(SEED_PREMIUM, gate.dayPts, cfg);
          pos = {
            side: sig.side, entryTime: c.time, entrySpot: _r2(c.open),
            optionEntryLtp: SEED_PREMIUM,
            targetPrem: strat.targetLevel(SEED_PREMIUM, cfg),
            stopPrem: stp.level, stopKind: stp.kind,
            strike: strat.itmStrike(c.open, sig.side, STEP),
            peakPrem: SEED_PREMIUM,
            orHigh: sig.orHigh, orLow: sig.orLow, vwap: sig.vwap, ema: sig.ema,
            breakoutTime: sig.breakoutTime, retestTime: sig.retestTime,
            signalBarTime: sig.signalBarTime, entryReason: sig.reason,
          };
          funnel.entries++;
        }
      }

      // 2. Manage an open position on this bar.
      if (pos) manage(c);

      // 3. The entry question, on this bar's close.
      if (!pos && !pending && !dayClosed) {
        const sig = strat.getSignal(sorted.slice(winStart, gi + 1), { cfg, silent: true, resumeAfterSec: lastExitSec });
        if (sig.warmup) { funnel.warmup++; dayNote = sig.skipReason; dayClosed = true; continue; }
        if (sig.dayDead) { funnel.incompleteOr++; dayNote = sig.skipReason; dayClosed = true; continue; }
        if (sig.phase === "up" || sig.phase === "down") sawBreakout = true;
        if (sig.signal !== "NONE" && sig.side) {
          funnel.signals++;
          if (c.time < reentryBlockUntil) continue;   // paper refuses and queues no retry
          if (j === idxs.length - 1) { dayNote = "signal on the day's last bar — nothing to fill on"; continue; }
          pending = sig;
          continue;
        }
        if (sig.phase === "closed") { dayClosed = true; if (!dayNote) dayNote = sig.skipReason; }
      }
    }

    if (pos) {
      const last = sorted[idxs[idxs.length - 1]];
      close(premAt(last.close, last.time), last.time, "Session end (last candle of the day)", "SESSION_END", true);
    }
    if (sawBreakout) funnel.breakouts++;
    if (!dayTrades.length) {
      funnel.noTradeDays++;
      skipped.push({ date: istDateOf(dayTs), reason: dayNote || "no valid setup" });
    }
  }

  const targetDays = new Set(trades.filter(t => t.exitCode === "TARGET").map(t => t.entry.split(",")[0]));
  funnel.targetDays = targetDays.size;
  return { trades, days: funnel.days, skipped, funnel, exitReasons, dayStops };
}

// ── Report extras (pure) ─────────────────────────────────────────────────────
function _bucketStats(list) {
  const n = list.length;
  const wins = list.filter(t => t.pnl > 0).length;
  const net = _r2(list.reduce((a, t) => a + t.pnl, 0));
  const pts = _r2(list.reduce((a, t) => a + (t.points || 0), 0));
  return { n, wins, losses: list.filter(t => t.pnl < 0).length, winRate: n ? _r2(wins / n * 100) : 0, net, pts };
}
function buildReport(trades) {
  const bySide = { CE: _bucketStats(trades.filter(t => t.side === "CE")), PE: _bucketStats(trades.filter(t => t.side === "PE")) };
  const monthMap = new Map(), timeMap = new Map();
  for (const t of trades) {
    const d = new Date((t.entryTs + 19800) * 1000);
    const mk = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
    const slot = Math.floor(mins / 30) * 30;
    const tk = `${String(Math.floor(slot / 60)).padStart(2, "0")}:${String(slot % 60).padStart(2, "0")}`;
    if (!monthMap.has(mk)) monthMap.set(mk, []);
    if (!timeMap.has(tk)) timeMap.set(tk, []);
    monthMap.get(mk).push(t); timeMap.get(tk).push(t);
  }
  const months = [...monthMap.keys()].sort().map(k => ({ key: k, ...(_bucketStats(monthMap.get(k))) }));
  const times = [...timeMap.keys()].sort().map(k => ({ key: k, ...(_bucketStats(timeMap.get(k))) }));
  let run = 0, maxConsecLosses = 0;
  for (const t of trades) {
    if (t.pnl < 0) { run++; if (run > maxConsecLosses) maxConsecLosses = run; } else run = 0;
  }
  return { bySide, months, times, maxConsecLosses };
}

const CSV_COLS = [
  ["entry", "Entry time"], ["exit", "Exit time"], ["side", "Side"], ["strike", "Strike (sim)"],
  ["ePrice", "Entry spot"], ["xPrice", "Exit spot"], ["eOpt", "Entry premium"], ["xOpt", "Exit premium"],
  ["target", "Target"], ["sl", "Stop"], ["points", "Points"], ["grossPnl", "Gross ₹"], ["charges", "Charges ₹"],
  ["pnl", "Net ₹"], ["exitCode", "Exit"], ["held", "Bars held"], ["orHigh", "Range H"], ["orLow", "Range L"],
  ["vwap", "VWAP"], ["ema", "EMA9"], ["breakout", "Breakout"], ["retest", "Retest"], ["reason", "Exit reason"],
  ["entryReason", "Entry reason"],
];
function toCsv(trades) {
  const cell = (v) => {
    const s = v == null ? "" : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [CSV_COLS.map(c => cell(c[1])).join(",")];
  for (const t of trades) lines.push(CSV_COLS.map(c => cell(t[c[0]])).join(","));
  return lines.join("\r\n") + "\r\n";
}

// ── Routes ──────────────────────────────────────────────────────────────────
router.get("/status", (req, res) => {
  const job = backtestJobs.getJob(req.query.jobId);
  if (!job) return res.json({ status: "not_found" });
  res.json({ status: job.status, progress: job.progress, elapsed: Date.now() - job.startedAt, error: job.error });
});

router.get("/idle", (req, res) => {
  if (req.accepts(["json", "html"]) === "json" || req.query.json === "1") return res.json({ idle: backtestJobs.isIdle() });
  return res.redirect(ENDPOINT);
});

router.get("/result", (req, res) => {
  const job = req.query.jobId ? backtestJobs.getJob(req.query.jobId) : null;
  if (!job) return res.status(404).json({ error: "not_found" });
  if (job.status !== "done") return res.json({ status: job.status, error: job.error || null });
  const { trades, stats, from, to, meta } = job.result;
  return res.json({ status: "done", from, to, stats, meta, trades });
});

router.get("/csv", (req, res) => {
  const job = req.query.jobId ? backtestJobs.getJob(req.query.jobId) : null;
  if (!job || job.status !== "done") return res.status(404).send("Backtest result not found — run the backtest again.");
  const { trades, from, to } = job.result;
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="itm20_scalp_backtest_${from}_${to}.csv"`);
  res.send("﻿" + toCsv(trades));
});

const MOBILE_CSS = `<style>
@media(max-width:640px){
  html,body{max-width:100%;overflow-x:hidden;}
  .main-content{padding-left:10px;padding-right:10px;}
  table{display:block;overflow-x:auto;-webkit-overflow-scrolling:touch;white-space:nowrap;}
  a,button,select,input{min-height:44px;}
  body{padding-left:env(safe-area-inset-left);padding-right:env(safe-area-inset-right);}
}
.iz-tbl{border-collapse:collapse;font-size:0.7rem;margin:6px 12px 6px 0;display:inline-table;vertical-align:top;}
.iz-tbl th,.iz-tbl td{padding:3px 8px;border-bottom:1px solid rgba(255,255,255,0.08);text-align:right;}
.iz-tbl th:first-child,.iz-tbl td:first-child{text-align:left;}
@media(max-width:640px){.iz-tbl{display:block;overflow-x:auto;}}
</style>`;

function _tableHtml(title, rows) {
  if (!rows.length) return "";
  const body = rows.map(r => `<tr><td>${escHtml(r.key)}</td><td>${r.n}</td><td>${r.wins}/${r.losses}</td><td>${r.winRate}%</td><td>${r.pts >= 0 ? "+" : ""}${r.pts}</td><td style="color:${r.net >= 0 ? "#10b981" : "#ef4444"}">₹${Math.round(r.net).toLocaleString("en-IN")}</td></tr>`).join("");
  return `<table class="iz-tbl"><thead><tr><th>${escHtml(title)}</th><th>Trades</th><th>W/L</th><th>Win %</th><th>Points</th><th>Net</th></tr></thead><tbody>${body}</tbody></table>`;
}

function _resultsView(from, to, trades, stats, meta, jobId) {
  const inf = (x) => x === Infinity ? "∞" : x;
  const cfg = strat.getConfig();
  const f = meta.funnel || {};
  const xr = meta.exitReasons || {};
  const exitMix = Object.keys(xr).length ? Object.entries(xr).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(" · ") : "—";
  const rep = buildReport(trades);
  const side = (s) => `${s.n} · ${s.winRate}% · ₹${Math.round(s.net).toLocaleString("en-IN")}`;

  const tables = `<div style="margin-top:10px;">${_tableHtml("CE / PE", [{ key: "CE", ...rep.bySide.CE }, { key: "PE", ...rep.bySide.PE }])}${_tableHtml("Month", rep.months)}${_tableHtml("Entry time", rep.times)}</div>`;
  const csvLink = jobId ? `<a href="${ENDPOINT}/csv?jobId=${encodeURIComponent(jobId)}" style="color:${ACCENT};display:inline-flex;align-items:center;min-height:44px;">⬇ Download all trades (CSV)</a> · ` : "";

  return {
    mode: "ITM20_SCALP",
    accent: ACCENT,
    strategyName: strat.NAME,
    endpoint: ENDPOINT,
    from, to,
    summary: stats,
    trades,
    activePage: "itm20ScalpBacktest",
    extraTradeColumns: [
      { key: "strike", label: "Strike" },
      { key: "eOpt", label: "Entry ₹" },
      { key: "xOpt", label: "Exit ₹" },
      { key: "points", label: "Pts" },
      { key: "exitCode", label: "Exit" },
      { key: "breakout", label: "BO" },
      { key: "retest", label: "RT" },
    ],
    extraStats: [
      { label: "Trading days", value: meta.days },
      { label: "No-trade days", value: f.noTradeDays || 0 },
      { label: "Target days", value: f.targetDays || 0 },
      { label: "Profit Factor", value: inf(stats.profitFactor) },
      { label: "Max consecutive losses", value: rep.maxConsecLosses },
      { label: "Max Drawdown", value: `₹${stats.maxDrawdown}` },
      { label: "Gross profit / loss", value: `₹${Math.round(stats.grossProfit).toLocaleString("en-IN")} / ₹${Math.round(stats.grossLoss).toLocaleString("en-IN")}` },
      { label: "CE (trades · win% · net)", value: side(rep.bySide.CE) },
      { label: "PE (trades · win% · net)", value: side(rep.bySide.PE) },
      { label: "Expiry days skipped", value: f.expirySkipped || 0 },
      { label: "Days with a breakout", value: f.breakouts || 0 },
      { label: "Signals → entries", value: `${f.signals || 0} → ${f.entries || 0}` },
      { label: "Exit mix", value: exitMix },
      { label: "Expectancy /trade", value: `₹${stats.expectancy}` },
    ],
    notes: `${csvLink}<b>Chart:</b> NIFTY 50 INDEX spot (<code>${escHtml(SPOT_SYMBOL)}</code>) 5-min. <b>Range:</b> ${strat._fmtMins(cfg.sessionStartMin)}–${strat._fmtMins(cfg.orEndMin)} high/low. <b>Entry:</b> close beyond the range with VWAP + EMA${cfg.emaPeriod} agreeing → retest within ${cfg.retestCandles} candles (±${escHtml(cfg.retestTolPts)}pt) without closing back inside → confirmation close; filled at the NEXT bar's open until ${strat._fmtMins(cfg.entryEndMin)}. <b>Exit:</b> premium +${escHtml(cfg.targetPts)} / −${escHtml(cfg.slPts)}, square-off ${strat._fmtMins(cfg.squareOffMin)}; a bar touching both counts as the stop. <b>Day:</b> max ${cfg.maxTrades} trades, stop after a win / 2 losses / −${escHtml(cfg.dailyLossPts)} pts; expiry day ${cfg.tradeExpiryDay ? "traded" : "skipped"}. <b>Premium is SIMULATED</b> (δ ${escHtml(process.env.BACKTEST_DELTA || "0.55")} + θ, seeded at ₹${escHtml(backtestCosts.seedPremium())}, ${escHtml(backtestCosts.slippagePts())}pt slippage each way, full charges) — there is no historical option-chain data, so ₹ are directional, not exact. Warm-up: ${escHtml(String(meta.warmupDays))} calendar day(s) before ${escHtml(from)}. <b>Never traded on paper or live; nothing here is validated.</b>${tables}`,
  };
}

function _renderResults(res, from, to, trades, stats, meta, jobId) {
  const html = renderBacktestResults(_resultsView(from, to, trades, stats, meta, jobId));
  res.send(html.replace("</body>", `${MOBILE_CSS}</body>`));
}

/**
 * One run, start to finish, on job `id` — fetch, simulate, save, then
 * completeJob / failJob. This page and the unified /backtest page both call it.
 */
async function _runJob(id, p) {
  const { from, to } = p;
  try {
    const { fetchFrom, fetchTo, warmupDays } = warmupRange(from, to);
    backtestJobs.updateProgress(id, { phase: `Fetching ${SPOT_SYMBOL} 5-min candles (${fetchFrom} → ${fetchTo})…`, pct: 10 });
    let intraday;
    try {
      intraday = await fetchCandlesCachedBT(SPOT_SYMBOL, String(RES), fetchFrom, fetchTo, false,
        (p) => backtestJobs.updateProgress(id, { phase: p && p.phase ? p.phase : `Fetching ${SPOT_SYMBOL}…`, pct: Math.min(65, 10 + Math.round((p && p.pct ? p.pct : 0) * 0.55)) }));
    } catch (err) {
      const msg = fyersErrText(err);
      backtestJobs.failJob(id, `Fyers refused the ${SPOT_SYMBOL} history request for ${fetchFrom} → ${fetchTo}: ${msg.slice(0, 200)}. "Could not authenticate the user" means the Fyers session needs re-login.`);
      return;
    }
    intraday = Array.isArray(intraday) ? intraday : [];
    if (!intraday.length) {
      backtestJobs.failJob(id, `Fyers returned no historical candles for ${SPOT_SYMBOL} ${fetchFrom} → ${fetchTo}. Most often the Fyers session needs re-login — an expired token returns no data rather than an auth error.`);
      return;
    }
    backtestJobs.updateProgress(id, { phase: `Running ITM20 Scalp backtest (${intraday.length.toLocaleString()} candles)…`, pct: 75 });
    const result = await runItm20ScalpBacktest(intraday, from);
    const stats = computeBacktestStats(result.trades);
    stats.optionSim = true;
    stats.delta = parseFloat(process.env.BACKTEST_DELTA || "0.55");
    stats.thetaPerDay = parseFloat(process.env.BACKTEST_THETA_DAY || "8");
    try { saveResult(RESULT_KEY, { summary: stats, params: { from, to, resolution: String(RES) } }); }
    catch (e) { console.warn(`${LOG} saveResult failed: ${e.message}`); }
    const fn = result.funnel;
    console.log(`${LOG} ${from}→${to}: ${fn.days} days | expiry skipped ${fn.expirySkipped} | signals ${fn.signals} → entries ${fn.entries} | exits ${JSON.stringify(result.exitReasons)}`);
    backtestJobs.completeJob(id, {
      trades: result.trades, stats, from, to,
      meta: { days: result.days, skipped: result.skipped, funnel: result.funnel, exitReasons: result.exitReasons, dayStops: result.dayStops, warmupDays, fetchFrom, candles: intraday.length },
    });
  } catch (err) {
    console.error(`${LOG} job error:`, err);
    backtestJobs.failJob(id, err.message);
  }
}

router.get("/", async (req, res) => {
  let { from, to } = req.query;
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  if (!from || !to || !dateRe.test(from) || !dateRe.test(to)) {
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    return res.redirect(`${ENDPOINT}?from=${shiftDateStr(today, 90)}&to=${today}`);
  }

  const jobId = req.query.jobId;
  if (!jobId) {
    if (backtestJobs.getActiveJob()) return res.send(backtestJobs.buildQueuePage(ENDPOINT, "ITM20 Scalp Backtest"));
    const { id } = backtestJobs.createJob("itm20_scalp");
    _runJob(id, { from, to });
    return res.send(backtestJobs.buildProgressPage(id, ENDPOINT, "ITM20 Scalp Backtest"));
  }

  const job = backtestJobs.getJob(jobId);
  if (!job) return res.redirect(ENDPOINT);
  if (job.status === "running") return res.send(backtestJobs.buildProgressPage(jobId, ENDPOINT, "ITM20 Scalp Backtest"));
  if (job.status === "error")   return res.status(500).send(renderErrorPage(job.error, from, to));
  const { trades, stats, meta } = job.result;
  return _renderResults(res, from, to, trades, stats, meta || { days: 0, funnel: {}, exitReasons: {}, warmupDays: _warmupDays() }, jobId);
});

function renderErrorPage(msg, from, to) {
  const light = require("../utils/theme").resolveTheme() === "light" ? ' data-theme="light"' : "";
  return `<!DOCTYPE html><html${light}><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>${faviconLink()}<title>ITM20 Scalp — Backtest Error</title>
<style>body{font-family:'IBM Plex Mono',monospace;background:#060810;color:#a0b8d8;padding:40px;text-align:center;}
h2{color:#ef4444;margin-bottom:12px;}p{margin-bottom:18px;word-break:break-word;}
a{color:${ACCENT};text-decoration:none;border:0.5px solid #0e1428;padding:8px 14px;border-radius:6px;display:inline-flex;min-height:44px;align-items:center;}
:root[data-theme="light"] body{background:#f4f6f9;color:#334155;}
@media(max-width:768px){body{padding:24px 14px;}}</style>
</head><body><h2>ITM20 Scalp Backtest Failed</h2><p>${escHtml(msg)}</p><p><b>${escHtml(from || "")}</b> → <b>${escHtml(to || "")}</b></p><a href="${ENDPOINT}">← Back</a></body></html>`;
}

module.exports = router;
// The unified /backtest page's hook (see services/backtestPage.js).
module.exports.backtestPage = {
  markets: ["NIFTY"],
  resolution: null,
  run: (id, p) => _runJob(id, { from: p.from, to: p.to }),
  view: (r, p) => _resultsView(r.from || p.from, r.to || p.to, r.trades, r.stats, r.meta || { days: 0, funnel: {}, exitReasons: {}, warmupDays: _warmupDays() }, p.jobId),
};
module.exports.runItm20ScalpBacktest = runItm20ScalpBacktest;
module.exports.buildReport = buildReport;
module.exports.toCsv = toCsv;
module.exports.warmupRange = warmupRange;
module.exports.shiftDateStr = shiftDateStr;

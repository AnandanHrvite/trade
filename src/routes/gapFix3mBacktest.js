/**
 * 3M GAP FIX SCALP BACKTEST — /gap-fix-3m-backtest
 * ─────────────────────────────────────────────────────────────────────────────
 * Date-range backtest on 3-minute NIFTY **FUTURES** candles. The gap detection,
 * the day-extreme freeze, the break-vs-return decision and the levels all come
 * from the SAME engine the paper route uses (src/strategies/gap_fix_3m.js) —
 * there is no second copy of the rules here. This file only re-implements the
 * paper route's exits, because paper is canonical:
 *
 *   for each closed 3-min futures bar:
 *     getSignal(bars up to here)   → BUY_CE / BUY_PE / NONE
 *   exits: stop (day extreme) → target (gap fill) → EOD
 *
 * CONTRACT ROLL. There is no continuous NIFTY futures series, so the range is
 * split into blocks by FRONT-MONTH contract using the identical roll rule the
 * live path uses (instrument.getFuturesExpiry: roll two days before the last
 * Tuesday), and each block is fetched from its own symbol. Bars from different
 * contracts are never adjacent inside one session, so a roll can never be
 * mistaken for a gap.
 *
 * CONSERVATIVE INTRA-BAR ORDERING (this is where naive backtests lie):
 *   • the adverse STOP is tested on the bar's high/low BEFORE the favourable
 *     target is tested, so a bar that touched both books the LOSS;
 *   • a bar that OPENED beyond a level fills at the OPEN, never at the better
 *     level — no assuming a fill the market never offered;
 *   • entry is the signal bar's CLOSE, exactly as paper reads it.
 *
 * There is NO historical option chain, so premium is δ+θ simulated. Treat ₹ as
 * DIRECTIONAL, not exact. A spread/slippage haircut of GAP3M_BT_SLIPPAGE_PTS is
 * applied EACH way — without it a backtest of option BUYING always flatters.
 */

const express = require("express");
const router  = express.Router();
const gapStrategy = require("../strategies/gap_fix_3m");
// fetchCandles, NOT fetchCandlesCachedBT. The cached variant is month-granular:
// it rewrites the requested range into WHOLE calendar months before calling
// Fyers, so "29 Jul → 9 Aug" goes out as 1–31 Jul and 1–31 Aug. That is harmless
// for a perpetual index but wrong for a futures contract — the widened range runs
// past today and past the contract's own expiry, and Fyers refuses it. This
// strategy's servable window is about one contract anyway, so a disk cache keyed
// by month would buy almost nothing.
const { fetchCandles } = require("../services/backtestEngine");
const { faviconLink } = require("../utils/sharedNav");
const { getCharges } = require("../utils/charges");
const { renderBacktestResults, computeBacktestStats } = require("../utils/backtestUI");
const { saveResult } = require("../utils/resultStore");
const backtestJobs = require("../utils/backtestJobManager");
const instrumentConfig = require("../config/instrument");

const ACCENT = "#0ea5e9";
const ENDPOINT = "/gap-fix-3m-backtest";
const RESULT_KEY = "GAP_FIX_3M_BACKTEST";

const _MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

function _utcSecToIstMins(unixSec) { return Math.floor((unixSec + 19800) / 60) % 1440; }
function _resMin() { return gapStrategy.getConfig().resolutionMins; }
function istDateOf(unixSec) {
  const d = new Date((unixSec + 19800) * 1000);
  return `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${d.getUTCFullYear()}`;
}
function istHHMMSS(unixSec) {
  const d = new Date((unixSec + 19800) * 1000);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}:${String(d.getUTCSeconds()).padStart(2, "0")}`;
}
function entryTsStr(unixSec) { return `${istDateOf(unixSec)}, ${istHHMMSS(unixSec)}`; }

// ── Futures contract roll ────────────────────────────────────────────────────
/**
 * A NIFTY monthly futures contract expires on the last TUESDAY of its month.
 * Confirmed against Fyers' own symbol master (public.fyers.in/sym_details/
 * NSE_FO.csv): NIFTY26AUGFUT expires 25-Aug-2026, 26SEP 29-Sep-2026, 26OCT
 * 27-Oct-2026 — all Tuesdays. Only currently-listed contracts can be backtested
 * at all (expired ones are delisted), so the older last-Thursday convention can
 * never apply to a range this page is able to serve.
 */
function _lastExpiryOf(year, monthIdx) {
  const lastDay = new Date(Date.UTC(year, monthIdx + 1, 0));
  const daysBack = (lastDay.getUTCDay() - 2 + 7) % 7; // 2 = Tuesday
  lastDay.setUTCDate(lastDay.getUTCDate() - daysBack);
  return lastDay;
}

/**
 * The expiry date of the FRONT-MONTH contract on a given calendar date. Mirrors
 * instrument.getFuturesExpiry(), which rolls once expiry is TWO days away or
 * nearer, so the expiring contract's last two illiquid sessions are never used.
 *
 * Two, not one. getFuturesExpiry() compares against a timestamp carrying a
 * time-of-day, so its `diffDays <= 1` test fires a whole day earlier than the
 * same test would on bare dates. Paper is canonical, so the backtest matches
 * what paper actually does rather than what the comment there used to imply —
 * otherwise the two read different contracts on the same two days each month.
 * @param {Date} d a UTC-midnight date standing for an IST calendar day
 */
function _frontMonthExpiry(d) {
  const y = d.getUTCFullYear(), m = d.getUTCMonth();
  const expiry = _lastExpiryOf(y, m);
  const diffDays = Math.floor((expiry.getTime() - d.getTime()) / 86400000);
  if (diffDays > 2) return expiry;
  const nm = m === 11 ? 0 : m + 1;
  const ny = m === 11 ? y + 1 : y;
  return _lastExpiryOf(ny, nm);
}

function _frontMonthSymbol(d) {
  const expiry = _frontMonthExpiry(d);
  return `NSE:NIFTY${String(expiry.getUTCFullYear()).slice(2)}${_MONTHS[expiry.getUTCMonth()]}FUT`;
}

/**
 * Split [from, to] into contiguous {symbol, from, to, expiry} blocks, one per
 * front-month contract. Returned dates are YYYY-MM-DD IST calendar days.
 *
 * The range is clamped to today: a futures contract has no history for a day
 * that has not happened yet, and asking for one is how a valid symbol still gets
 * refused.
 *
 * `expiry` is reported rather than used. It is what lets a test check the split
 * against Fyers' real symbol master instead of against the rule that produced it —
 * the only way to catch the roll drifting away from the exchange again. Don't drop
 * it because nothing at runtime reads it.
 */
function buildContractBlocks(from, to, todayStr) {
  const start = new Date(`${from}T00:00:00Z`);
  let   end   = new Date(`${to}T00:00:00Z`);
  if (isNaN(start.getTime()) || isNaN(end.getTime())) return [];
  const today = new Date(`${todayStr || new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" })}T00:00:00Z`);
  if (!isNaN(today.getTime()) && end > today) end = today;
  if (start > end) return [];
  const blocks = [];
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const sym = _frontMonthSymbol(d);
    const ds = d.toISOString().slice(0, 10);
    const last = blocks[blocks.length - 1];
    if (last && last.symbol === sym) last.to = ds;
    else blocks.push({ symbol: sym, from: ds, to: ds, expiry: _frontMonthExpiry(d).toISOString().slice(0, 10) });
  }
  return blocks;
}

/**
 * The date window the CURRENT front-month contract covers, i.e. the range Fyers
 * is certain to serve. Walks back from `today` while the front-month symbol is
 * unchanged; the cap is a safety stop, not a business rule.
 *
 * This is the default backtest range because a NIFTY futures contract is
 * DELISTED after it expires and Fyers then rejects the symbol outright — so the
 * repo-standard "last 90 days" default would always start on a dead contract.
 *
 * @param {string} todayStr "YYYY-MM-DD" (IST calendar day)
 * @returns {{ from: string, to: string, symbol: string }}
 */
function currentContractWindow(todayStr) {
  let today = new Date(`${todayStr}T00:00:00Z`);
  if (isNaN(today.getTime())) {
    // Never echo an unparseable value back — it would be redirected into the URL
    // and the page would loop on itself. Fall back to the real IST today.
    todayStr = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    today = new Date(`${todayStr}T00:00:00Z`);
  }
  const symbol = _frontMonthSymbol(today);
  const d = new Date(today);
  for (let i = 0; i < 120; i++) {
    const prev = new Date(d);
    prev.setUTCDate(prev.getUTCDate() - 1);
    if (_frontMonthSymbol(prev) !== symbol) break;
    d.setTime(prev.getTime());
  }
  return { from: d.toISOString().slice(0, 10), to: todayStr, symbol };
}

/**
 * @param {Array} intraday GAP3M_RESOLUTION-minute FUTURES candles across the
 *        range, ascending, carrying volume. No warm-up runway is needed: this
 *        engine has no indicator to seed — every level is a fact about the
 *        current session.
 */
function runGapFix3mBacktest(intraday) {
  if (!intraday || !intraday.length) return { trades: [], days: 0, skipped: [], gapStats: { gaps: 0, brokeOut: 0, noReturn: 0, unknownVol: 0 } };

  const cfg = gapStrategy.getConfig();
  const DELTA        = parseFloat(process.env.BACKTEST_DELTA || "0.55");
  const THETA_DAY    = parseFloat(process.env.BACKTEST_THETA_DAY || "8");
  const LOT_SIZE     = instrumentConfig.getLotQty();
  const SEED_PREMIUM = parseFloat(process.env.GAP3M_BT_SEED_PREMIUM || "240");
  const SLIPPAGE_PTS = parseFloat(process.env.GAP3M_BT_SLIPPAGE_PTS || "1.5");
  const RES          = cfg.resolutionMins;

  const MAX_TRADES   = Math.max(1, parseInt(process.env.GAP3M_MAX_DAILY_TRADES || "3", 10) || 3);
  const MAX_LOSSES   = Math.max(0, parseInt(process.env.GAP3M_MAX_DAILY_LOSSES || "2", 10));
  const MAX_DAY_LOSS = parseFloat(process.env.GAP3M_MAX_DAILY_LOSS    || "3000");
  const PROFIT_LOCK  = parseFloat(process.env.GAP3M_DAILY_PROFIT_LOCK || "0");
  const FORCED_EXIT_MIN = gapStrategy._parseHHMM(process.env.GAP3M_FORCED_EXIT, 15 * 60 + 15);

  const sorted = intraday.slice().sort((a, b) => a.time - b.time);

  // Group by IST day. Unlike the indicator-based engines this one is evaluated
  // against TODAY's bars only — a gap, a day high and a day low are all facts
  // about the current session, and letting yesterday's bars into the window
  // would let an overnight gap arm an intraday trade.
  const dayKeys = [];
  const byDay = new Map();
  for (let i = 0; i < sorted.length; i++) {
    const k = gapStrategy._istDayOf(sorted[i].time);
    if (!byDay.has(k)) { byDay.set(k, []); dayKeys.push(k); }
    byDay.get(k).push(sorted[i]);
  }

  const trades = [];
  const skipped = [];
  let days = 0;
  const gapStats = { gaps: 0, brokeOut: 0, noReturn: 0, unknownVol: 0 };

  for (const k of dayKeys) {
    const bars = byDay.get(k);
    if (!bars || bars.length < 3) continue;
    days++;
    const dayTs = bars[0].time;

    let dayPnl = 0, dayTrades = 0, dayStopOuts = 0, dayClosed = false;
    let pos = null;
    let sawGap = false;

    function priceAt(exitPx, exitTime) {
      const barsHeld = Math.max(0, (exitTime - pos.entryTime) / 60 / RES);
      const barsPerDay = Math.max(1, Math.round(375 / RES));
      const thetaCost = (THETA_DAY * barsHeld) / barsPerDay;
      const move = pos.side === "CE" ? (exitPx - pos.entrySpot) : (pos.entrySpot - exitPx);
      const raw = Math.max(0.05, pos.optionEntryLtp + move * DELTA - thetaCost / LOT_SIZE);
      const exitPrem = Math.max(0.05, raw - 2 * SLIPPAGE_PTS);   // buy high + sell low
      const charges = getCharges({ broker: "fyers", isFutures: false, entryPremium: pos.optionEntryLtp, exitPremium: exitPrem, qty: LOT_SIZE });
      return {
        pnl: parseFloat(((exitPrem - pos.optionEntryLtp) * LOT_SIZE - charges).toFixed(2)),
        exitPrem: parseFloat(exitPrem.toFixed(2)),
        held: Math.round(barsHeld),
      };
    }
    function close(exitPx, exitTime, reason, isStopOut) {
      const p = priceAt(exitPx, exitTime);
      dayPnl += p.pnl;
      if (isStopOut) dayStopOuts++;
      trades.push({
        side: pos.side,
        entry: entryTsStr(pos.entryTime), exit: entryTsStr(exitTime),
        entryTs: pos.entryTime, exitTs: exitTime,
        ePrice: pos.entrySpot, xPrice: parseFloat(exitPx.toFixed(2)),
        sl: pos.slSpot, target: pos.targetSpot,
        riskPts: pos.slPts, targetPts: pos.targetPts, rr: pos.rr,
        gapDir: pos.gapDir, gapSize: pos.gapSize, gapTop: pos.gapTop, gapBottom: pos.gapBottom,
        dayHigh: pos.dayHigh, dayLow: pos.dayLow,
        crossed: pos.crossed, volume: pos.volume, volumeAvg: pos.volumeAvg,
        pnl: p.pnl, reason, entryReason: pos.entryReason,
        strength: "STRONG",
        eOpt: pos.optionEntryLtp, xOpt: p.exitPrem, held: p.held,
      });
      pos = null;
      // Day-level breakers — identical thresholds to the paper route.
      if (MAX_DAY_LOSS > 0 && dayPnl <= -MAX_DAY_LOSS) dayClosed = true;
      else if (PROFIT_LOCK > 0 && dayPnl >= PROFIT_LOCK) dayClosed = true;
      else if (MAX_LOSSES > 0 && dayStopOuts >= MAX_LOSSES) dayClosed = true;
      else if (dayTrades >= MAX_TRADES) dayClosed = true;
    }

    for (let i = 0; i < bars.length; i++) {
      const c = bars[i];
      const istMin = _utcSecToIstMins(c.time);

      // ── Manage an open position on THIS bar. ───────────────────────────────
      if (pos) {
        if (istMin >= FORCED_EXIT_MIN) {
          close(c.open, c.time, `EOD square-off (${process.env.GAP3M_FORCED_EXIT || "15:15"} IST) — gap never filled`, false);
        } else {
          const slOk = Number.isFinite(pos.slSpot);
          const tgOk = Number.isFinite(pos.targetSpot);
          const isCE = pos.side === "CE";
          const stopTouched = slOk && (isCE ? c.low <= pos.slSpot : c.high >= pos.slSpot);
          const tgtTouched  = tgOk && (isCE ? c.high >= pos.targetSpot : c.low <= pos.targetSpot);

          if (stopTouched) {
            // Worse-of open/level fill; a gap through the stop fills at the open.
            const fill = isCE
              ? (c.open < pos.slSpot ? c.open : pos.slSpot)
              : (c.open > pos.slSpot ? c.open : pos.slSpot);
            close(fill, c.time, `Day ${isCE ? "low" : "high"} taken out — stop ${pos.slSpot} hit (${pos.slPts}pt against)`, true);
          } else if (tgtTouched) {
            const fill = isCE
              ? (c.open > pos.targetSpot ? c.open : pos.targetSpot)
              : (c.open < pos.targetSpot ? c.open : pos.targetSpot);
            close(fill, c.time, `Gap filled — ${pos.gapSize}pt ${pos.gapDir} gap closed at ${pos.targetSpot}`, false);
          }
        }
      }

      // ── Look for a new entry on this bar's close. ──────────────────────────
      if (!pos && !dayClosed && dayTrades < MAX_TRADES) {
        const closeMins = istMin + RES;
        if (closeMins > cfg.entryEndMin) continue;
        const sig = gapStrategy.getSignal(bars.slice(0, i + 1), { cfg, silent: true });
        if (sig.gap && !sawGap) sawGap = true;
        if (sig.gap) {
          gapStats.gaps++;
          if (sig.signal === "NONE") {
            if (sig.crossed && sig.strongVolume) gapStats.brokeOut++;
            else if (sig.crossed && !sig.volumeKnown) gapStats.unknownVol++;
            else if (sig.returned === false) gapStats.noReturn++;
          }
        }
        if (sig.signal === "NONE" || !sig.side) continue;

        pos = {
          side: sig.side,
          entryTime: c.time,
          entrySpot: sig.entrySpot,          // the bar's CLOSE — same as paper
          optionEntryLtp: SEED_PREMIUM,
          slSpot: sig.slSpot,
          targetSpot: sig.targetSpot,
          slPts: sig.slPts, targetPts: sig.targetPts, rr: sig.rr,
          gapDir: sig.gapDir, gapSize: sig.gapSize, gapTop: sig.gapTop, gapBottom: sig.gapBottom,
          dayHigh: sig.dayHigh, dayLow: sig.dayLow,
          crossed: sig.crossed, volume: sig.volume, volumeAvg: sig.volumeAvg,
          entryReason: sig.reason,
        };
        dayTrades++;
      }
    }

    if (pos) {
      const last = bars[bars.length - 1];
      close(last.close, last.time, "EOD (end of day candles) — gap never filled", false);
    }
    if (!sawGap) skipped.push({ date: istDateOf(dayTs), reason: `no gap of ${cfg.minGapPts}pt or more all session` });
  }

  return { trades, days, skipped, gapStats };
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

/** Total contract blocks a run attempted, however each one turned out. */
function blocksTotal(meta) {
  return (meta.served || []).length + (meta.rejected || []).length + (meta.empty || []).length;
}

/**
 * Readable text for whatever the Fyers SDK threw.
 *
 * On an HTTP error the SDK rejects with the raw Fyers body — a PLAIN OBJECT
 * ({s, code, message, data}), not an Error. Reading only `.message` off it
 * reduces every parameter complaint to the bare word "Invalid input" and throws
 * away `data`, which is the one field that says WHICH parameter Fyers disliked
 * (e.g. {range_to: "Date range cannot exceed 366 days…"}). Keep the whole thing.
 */
function fyersErrText(err) {
  if (err && typeof err === "object" && !(err instanceof Error)) {
    const bits = [err.message || err.s || "error"];
    if (err.code != null) bits.push(`code ${err.code}`);
    if (err.data && typeof err.data === "object") {
      const detail = Object.entries(err.data).map(([k, v]) => `${k}: ${v}`).join("; ");
      if (detail) bits.push(detail);
    } else if (err.data) bits.push(String(err.data));
    return bits.join(" — ");
  }
  return String((err && err.message) || err);
}

/** Escape text that came from an external API before it lands in the notes HTML. */
function escHtml(x) {
  return String(x == null ? "" : x).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function _renderResults(res, from, to, trades, stats, meta) {
  const inf = (x) => x === Infinity ? "∞" : x;
  const cfg = gapStrategy.getConfig();
  const gs = meta.gapStats || { gaps: 0, brokeOut: 0, noReturn: 0, unknownVol: 0 };
  const served = meta.served || [];
  const rejected = meta.rejected || [];
  const empty = meta.empty || [];
  // A partially-served range is NOT the same result as a fully-served one, and a
  // silent gap in coverage reads as "nothing traded then". Say it out loud — and
  // keep REFUSED (contract delisted, unfetchable forever) separate from EMPTY
  // (no trading days in that window), because they call for different actions.
  const emptyNote = empty.length
    ? ` ${empty.length} block(s) returned no candles at all (${empty.map(e => `<code>${escHtml(e.symbol)}</code> ${escHtml(e.from)}→${escHtml(e.to)}`).join(", ")}) — normally a window with no trading days in it, but an expired Fyers token also returns no data rather than an auth error.`
    : "";
  const coverage = rejected.length
    ? `<b style="color:#f59e0b;">⚠ Partial coverage — ${rejected.length} of ${blocksTotal(meta)} contract(s) were REFUSED by Fyers:</b> ${rejected.map(r => `<code>${escHtml(r.symbol)}</code> ${escHtml(r.from)}→${escHtml(r.to)} (${escHtml(r.error)})`).join(", ")}. ${rejected.every(r => r.delisted) ? "A NIFTY futures contract is delisted once it expires, so Fyers cannot serve history for a month that has already passed" : "Each reason above is Fyers' own"} — those sessions are simply absent from everything below, not flat.${emptyNote} `
    : `Contracts fetched: ${served.map(s => `<code>${escHtml(s.symbol)}</code> ${escHtml(s.from)}→${escHtml(s.to)}`).join(", ") || "—"}.${emptyNote} `;
  const html = renderBacktestResults({
    mode: "GAP_FIX_3M",
    accent: ACCENT,
    strategyName: gapStrategy.NAME,
    endpoint: ENDPOINT,
    from, to,
    summary: stats,
    trades,
    activePage: "gapFix3mBacktest",
    extraTradeColumns: [
      { key: "gapSize", label: "Gap (pt)" },
      { key: "riskPts", label: "Risk (pt)" },
      { key: "targetPts", label: "Target (pt)" },
      { key: "rr", label: "R:R" },
      { key: "held", label: "Held" },
    ],
    extraStats: [
      { label: "Profit Factor", value: inf(stats.profitFactor) },
      { label: "Expectancy /trade", value: `₹${stats.expectancy}` },
      { label: "Max Drawdown", value: `₹${stats.maxDrawdown}` },
      { label: "Sessions scanned", value: meta.days },
      { label: "Gap setups seen", value: gs.gaps },
      { label: "Skipped — real breakout", value: gs.brokeOut },
      { label: "Skipped — volume unknown", value: gs.unknownVol },
      { label: "Skipped — never returned", value: gs.noReturn },
      { label: "Trade frequency", value: meta.days ? `${((trades.length / meta.days) * 100).toFixed(1)}% of sessions` : "—" },
    ],
    notes: `${coverage}<b>Chart:</b> NIFTY <b>FUTURES</b> ${cfg.resolutionMins}-min, front-month, rolled two days before the last Tuesday (NIFTY futures expiry) exactly as the live path does. The NIFTY 50 index is not read here — measured on this repo's own cached index candles the largest intraday 5-min index gap over 39 sessions was 2.1 points, because an index is a computed average with no order book. <b>Setup:</b> a gap of ≥ ${cfg.minGapPts}pt between two consecutive bars (a price void, strict inequality), then the next ${cfg.confirmBars} bar(s) decide — if the bar breaks the day's high/low with volume ≥ ${cfg.volMult}× the average of the previous ${cfg.volAvgBars} bars the breakout is treated as REAL and skipped; if it returns instead (<code>${cfg.returnMode}</code>) the gap is faded. <b>Levels:</b> target = the gap's fill level, stop = the day extreme frozen as of the gap bar${cfg.slBufferPts ? ` ± ${cfg.slBufferPts}pt` : ""}. Neither ever moves; there is no trail, no breakeven, no time stop and no premium stop. Optional guards ${cfg.maxSlPts || cfg.minRR || cfg.maxExtremeDist ? `<b>ON</b>: ${[cfg.maxSlPts ? `max SL ${cfg.maxSlPts}pt` : null, cfg.minRR ? `min R:R ${cfg.minRR}` : null, cfg.maxExtremeDist ? `gap within ${cfg.maxExtremeDist}pt of the extreme` : null].filter(Boolean).join(", ")}` : "are all OFF (defaults)"}. Max ${process.env.GAP3M_MAX_DAILY_TRADES || "3"} trades/day, day ends on ${process.env.GAP3M_MAX_DAILY_LOSSES || "2"} stop-outs / ₹${process.env.GAP3M_MAX_DAILY_LOSS || "3000"} loss. <b>Intra-bar ordering is conservative:</b> the stop is tested on the bar high/low BEFORE the target, so a bar touching both books the loss, and a bar that opened beyond a level fills at the open. Option premium is δ+θ simulated (BACKTEST_DELTA ${process.env.BACKTEST_DELTA || "0.55"}, θ ₹${process.env.BACKTEST_THETA_DAY || "8"}/day) seeded at ₹${process.env.GAP3M_BT_SEED_PREMIUM || "240"}, PLUS ${process.env.GAP3M_BT_SLIPPAGE_PTS || "1.5"}pt slippage EACH way — treat ₹ as directional, not exact. <b>This strategy has NEVER traded live or on paper. Nothing here is validated, and the futures gap frequency has never been measured.</b>`,
  });
  res.send(html);
}

router.get("/", async (req, res) => {
  let { from, to } = req.query;
  if (!from || !to) {
    // NOT the repo-standard 90 days: an expired NIFTY futures contract is
    // delisted and Fyers refuses the symbol, so a 90-day default would always
    // open on a dead contract. Default to the window the CURRENT front-month
    // contract covers — the range Fyers is certain to serve. Widen it by hand
    // and the run still works, it just reports which contracts were refused.
    const win = currentContractWindow(new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }));
    return res.redirect(`${ENDPOINT}?from=${win.from}&to=${win.to}`);
  }

  const jobId = req.query.jobId;
  if (!jobId) {
    const activeJob = backtestJobs.getActiveJob();
    if (activeJob) return res.send(backtestJobs.buildQueuePage(ENDPOINT, "3M Gap Fix Scalp Backtest"));
    const { id } = backtestJobs.createJob("gap_fix_3m");
    (async () => {
      try {
        console.log(`🔍 3M_GAP_FIX_SCALP Backtest job ${id}: ${from} → ${to}`);
        const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
        const win = currentContractWindow(todayStr);
        const blocks = buildContractBlocks(from, to, todayStr);
        if (!blocks.length) {
          // The range is clamped to today, so a well-formed range can still empty
          // out — by lying entirely in the future. That is not a malformed date,
          // and saying so sends the reader hunting for a typo that is not there.
          const parsable = !isNaN(new Date(`${from}T00:00:00Z`).getTime());
          backtestJobs.failJob(id, parsable && from > todayStr
            ? `${from} → ${to} is in the future — there is no futures history for a session that has not happened yet. The current contract's window is ${ENDPOINT}?from=${win.from}&to=${win.to} (${win.symbol}).`
            : `Invalid date range ${from} → ${to}.`);
          return;
        }

        // Fetch each contract INDEPENDENTLY. A NIFTY futures contract is delisted
        // once it expires and Fyers then answers "Invalid symbol provided" — which
        // fetchChunk raises as a throw. Letting that escape meant one dead contract
        // killed a whole multi-month run, so every block is isolated: what Fyers
        // still serves is kept, what it refuses is recorded and reported.
        // REFUSED and EMPTY are different diagnoses and must not be merged.
        //   refused — Fyers actively rejected the symbol (a throw). The contract
        //             is delisted, and those sessions can never be fetched.
        //   empty   — the call succeeded but returned nothing. That is a block
        //             with no trading days in it (a short holiday window), OR an
        //             expired token, which returns no_data rather than an auth
        //             error. Calling that "delisted" is the misdiagnosis this
        //             repo has already been bitten by once.
        const all = [];
        const served = [];
        const rejected = [];
        const empty = [];
        for (let b = 0; b < blocks.length; b++) {
          const blk = blocks[b];
          backtestJobs.updateProgress(id, { phase: `Fetching ${blk.symbol} (${blk.from} → ${blk.to})…`, pct: Math.round((b / blocks.length) * 65) });
          try {
            // Exact range, block by block. The roll already ends every block a
            // day before its contract expires, and the range was clamped to
            // today, so no request can reach for a session this symbol never had.
            const part = await fetchCandles(blk.symbol, String(_resMin()), blk.from, blk.to);
            const n = Array.isArray(part) ? part.length : 0;
            if (n > 0) { all.push(...part); served.push({ ...blk, candles: n }); }
            else empty.push({ ...blk });
          } catch (err) {
            const msg = fyersErrText(err);
            const delisted = /Invalid symbol/i.test(msg);
            rejected.push({ ...blk, delisted, error: delisted ? "contract expired — Fyers no longer lists it" : msg.slice(0, 200) });
            console.warn(`[gap-fix-3m-backtest] ${blk.symbol} (${blk.from} → ${blk.to}) refused: ${msg.slice(0, 300)}`);
          }
        }
        const intraday = all.sort((a, b) => a.time - b.time);
        if (intraday.length < 50) {
          const rejList = rejected.map(r => `${r.symbol} (${r.error})`).join("; ");
          // Only blame delisting when Fyers actually said the symbol is unknown.
          // Any other refusal — a bad parameter, a dead session — has its own
          // reason attached, and dressing it up as "expired contract" sends the
          // reader to fix the one thing that is not wrong.
          const allDelisted = rejected.length > 0 && rejected.every(r => r.delisted);
          backtestJobs.failJob(id,
            rejected.length && !served.length
              ? allDelisted
                ? `No usable futures data for ${from} → ${to}. Every contract in that range was refused by Fyers: ${rejList}. ` +
                  `A NIFTY futures contract is DELISTED after it expires, so history for a month that has already passed can never be fetched — this strategy can only be backtested over contracts that still exist. ` +
                  `Try ${ENDPOINT}?from=${win.from}&to=${win.to} (the current ${win.symbol} contract).`
                : `Fyers refused every contract for ${from} → ${to}: ${rejList}. That wording is Fyers' own — it names what it rejected. ` +
                  `"Could not authenticate the user" means the Fyers session needs re-login; anything else is a request Fyers would not serve, not a missing contract. ` +
                  `The current contract's own window is ${ENDPOINT}?from=${win.from}&to=${win.to} (${win.symbol}).`
              : intraday.length === 0
                ? `Fyers returned no historical candles for ${from} → ${to} on ${blocks.map(b => b.symbol).join(", ")}. Most often the Fyers session needs re-login — an expired token returns no data (not an auth error). Log in to Fyers again, then retry.`
                : `Only ${intraday.length} futures candle(s) for ${from} → ${to}${rejList ? ` (unavailable: ${rejList})` : ""} — widen the range or use the current contract's own window (${win.from} → ${win.to}).`);
          return;
        }

        backtestJobs.updateProgress(id, { phase: `Running 3M Gap Fix Scalp backtest (${intraday.length.toLocaleString()} futures candles)…`, pct: 75 });
        const result = runGapFix3mBacktest(intraday);
        const stats = computeBacktestStats(result.trades);
        stats.optionSim = true;
        stats.delta = parseFloat(process.env.BACKTEST_DELTA || "0.55");
        stats.thetaPerDay = parseFloat(process.env.BACKTEST_THETA_DAY || "8");

        try { saveResult(RESULT_KEY, { summary: stats, params: { from, to, resolution: String(_resMin()) } }); }
        catch (e) { console.warn("[gap-fix-3m-backtest] saveResult failed:", e.message); }

        backtestJobs.completeJob(id, { trades: result.trades, stats, from, to, meta: { days: result.days, skipped: result.skipped, gapStats: result.gapStats, served, rejected, empty } });
        console.log(`✅ 3M_GAP_FIX_SCALP Backtest job ${id} complete — ${result.trades.length} trades over ${result.days} sessions (${result.gapStats.gaps} gap setups seen)`);
      } catch (err) {
        console.error("[gap-fix-3m-backtest] job error:", err);
        backtestJobs.failJob(id, err.message);
      }
    })();
    return res.send(backtestJobs.buildProgressPage(id, ENDPOINT, "3M Gap Fix Scalp Backtest"));
  }

  const job = backtestJobs.getJob(jobId);
  if (!job) return res.redirect(ENDPOINT);
  if (job.status === "running") return res.send(backtestJobs.buildProgressPage(jobId, ENDPOINT, "3M Gap Fix Scalp Backtest"));
  if (job.status === "error")   return res.status(500).send(renderErrorPage(job.error, from, to));
  const { trades, stats, meta } = job.result;
  return _renderResults(res, from, to, trades, stats, meta || { days: 0, skipped: [], gapStats: {} });
});

function renderErrorPage(msg, from, to) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>${faviconLink()}<title>3M Gap Fix Scalp Backtest Error</title>
<style>body{font-family:'IBM Plex Mono',monospace;background:#060810;color:#a0b8d8;padding:40px;text-align:center;}
h2{color:#ef4444;margin-bottom:12px;}p{margin-bottom:18px;}
a{color:${ACCENT};text-decoration:none;border:0.5px solid #0e1428;padding:8px 14px;border-radius:6px;}</style>
</head><body><h2>3M Gap Fix Scalp Backtest Failed</h2><p>${escHtml(msg)}</p><p><b>${escHtml(from || "")}</b> → <b>${escHtml(to || "")}</b></p><a href="${ENDPOINT}">← Back</a></body></html>`;
}

module.exports = router;
// Exposed for offline unit-testing of the entry/exit engine (no Fyers needed).
module.exports.runGapFix3mBacktest = runGapFix3mBacktest;
module.exports.buildContractBlocks = buildContractBlocks;
module.exports.currentContractWindow = currentContractWindow;

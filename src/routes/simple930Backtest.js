/**
 * SIMPLE_9:30 BACKTEST — /simple930-backtest
 * ─────────────────────────────────────────────────────────────────────────────
 * Date-range backtest on REAL 1-minute NIFTY OPTION candles. There is no delta
 * model and no theta model here: this strategy is defined entirely on option
 * premium, so simulating the premium would be simulating the strategy. Every
 * number below is a price Fyers actually printed for the contract the rule
 * would have picked.
 *
 * The selection, the ₹180 trigger, the stop/trail geometry and the 09:45 box
 * all come from the SAME engine the paper route uses
 * (src/strategies/simple930.js) — no rule is re-implemented here. This file
 * only re-implements paper's EXITS on bar data, because paper is canonical.
 *
 * ── WHAT CAN AND CANNOT BE BACKTESTED ───────────────────────────────────────
 * A NIFTY weekly option is DELISTED the moment it expires, and Fyers then
 * refuses the symbol. So this page can only reach back as far as the currently
 * listed contracts — in practice the current expiry week, and whatever later
 * weeklies are already listed. Older dates are not "flat", they are UNFETCHABLE,
 * and the results page says so per day rather than quietly reporting no trades.
 * That is also why the default range is this week, not the repo-standard 90 days.
 *
 * ── HOW A DAY IS SIMULATED ──────────────────────────────────────────────────
 *  1. NIFTY index 1-min candles → the OPEN of the 09:25 bar is the spot the
 *     live route would have sampled on its first poll at/after 09:25:00.
 *  2. ATM strike → the ladder → one 1-min option series per rung.
 *  3. The OPEN of each rung's 09:25 bar is its selection premium; the engine's
 *     own selectWatchlist picks one strike per side.
 *  4. Entry: walk minute by minute across the entry window, both legs together.
 *     A bar whose HIGH is above the trigger fills at max(open, trigger) — the
 *     trigger level on an intrabar cross, the open when the bar started above.
 *  5. Exits, per bar, in this exact order (conservative throughout):
 *        a. EOD reached                 → fill at the bar OPEN
 *        b. bar OPEN already ≤ stop     → fill at the bar OPEN (gapped through)
 *        c. 09:45 reached and the trade never left the box → fill at the OPEN
 *           (the box is judged on everything BEFORE this bar, which is what the
 *            live route sees when it checks at 09:45:00)
 *        d. bar LOW ≤ stop              → fill at the STOP
 *        e. otherwise fold the bar's high into the peak, ratchet the trail
 *     The adverse test always runs before the favourable one, and the entry bar
 *     is tested the same way as any other — its low is assumed to come after the
 *     fill, never before.
 *  6. SIMPLE930_BT_SLIPPAGE_PTS is charged EACH way (paid up on entry, given up
 *     on exit). Without it a backtest of option BUYING always flatters.
 *     Statutory charges come from the repo's own charges.js on the ZERODHA
 *     schedule, because that is where these orders would go.
 *
 * NOT VALIDATED. This strategy has never traded live or on paper.
 */

const express = require("express");
const router  = express.Router();

const strategy         = require("../strategies/simple930");
// fetchCandles, NOT fetchCandlesCachedBT. The cached variant is month-granular:
// it rewrites the requested range into WHOLE calendar months before calling
// Fyers. That is harmless for a perpetual index but wrong for a weekly option —
// the widened range runs past the contract's own expiry and Fyers refuses it.
const { fetchCandles } = require("../services/backtestEngine");
const { fyersErrText } = require("../utils/fyersErr");
const { faviconLink }  = require("../utils/sharedNav");
const { getCharges }   = require("../utils/charges");
const { renderBacktestResults, computeBacktestStats } = require("../utils/backtestUI");
const { saveResult }   = require("../utils/resultStore");
const backtestJobs     = require("../utils/backtestJobManager");
const instrumentConfig = require("../config/instrument");
const { isNonTradingDay, getPreviousTradingDay, formatDateToYYYYMMDD } = require("../utils/nseHolidays");

const ACCENT      = "#f59e0b";
const ENDPOINT    = "/simple930-backtest";
const RESULT_KEY  = "SIMPLE930_BACKTEST";
const SPOT_SYMBOL = "NSE:NIFTY50-INDEX";
const RES         = "1";                 // 1-minute bars — the finest Fyers serves
const WEEKLY_EXPIRY_DOW = 2;             // Tuesday (NSE moved NIFTY weeklies off Thursday)

// ── time helpers ─────────────────────────────────────────────────────────────
// IST arithmetic comes from the engine, not from a second copy here: the engine
// header is explicit that routes must not re-derive it, and two implementations
// that agree today are two that can drift tomorrow.
const _istMins   = strategy._utcSecToIstMins;
const _istDayStr = strategy._istDateStr;

function _ddmmyyyy(unixSec) {
  const d = new Date((unixSec + 19800) * 1000);
  return `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${d.getUTCFullYear()}`;
}
function _hhmmss(unixSec) {
  const d = new Date((unixSec + 19800) * 1000);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}:${String(d.getUTCSeconds()).padStart(2, "0")}`;
}
function _ts(unixSec) { return `${_ddmmyyyy(unixSec)}, ${_hhmmss(unixSec)}`; }
function _todayStr() { return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }); }
function escHtml(x) {
  return String(x == null ? "" : x).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Backtest slippage, charged on BOTH sides. */
function _slippagePts() {
  const v = parseFloat(process.env.SIMPLE930_BT_SLIPPAGE_PTS);
  return Number.isFinite(v) && v >= 0 && v <= 50 ? v : 1.5;
}

/**
 * The weekly-expiry DATE on or after an IST calendar day, holiday-preponed.
 *
 * Mirrors instrument.getNearestWeeklyExpiryDate()'s rule (next Tuesday, today
 * counting while its session is open) but for an ARBITRARY past date, which the
 * live helper cannot express. A preponed expiry is asked of the shared holiday
 * list, so the code this builds is the one that actually traded that week.
 */
async function weeklyExpiryOnOrAfter(dayStr) {
  const utc = new Date(`${dayStr}T00:00:00Z`);
  if (isNaN(utc.getTime())) return null;
  const days = (WEEKLY_EXPIRY_DOW - utc.getUTCDay() + 7) % 7;
  const e = new Date(utc.getTime() + days * 86400000);
  // expiryCodeFor reads LOCAL date parts, and the server runs on Asia/Calcutta,
  // so rebuild the date in local terms before handing it over.
  let local = new Date(e.getUTCFullYear(), e.getUTCMonth(), e.getUTCDate(), 12, 0, 0, 0);
  try {
    if (await isNonTradingDay(local)) local = await getPreviousTradingDay(local);
  } catch (_) { /* holiday list unavailable → use the scheduled date */ }
  return { date: local, code: instrumentConfig.expiryCodeFor(local), dateStr: formatDateToYYYYMMDD(local) };
}

/** Group an ascending candle array by IST day. */
function byDay(candles) {
  const m = new Map();
  for (const c of candles || []) {
    if (!c || typeof c.time !== "number") continue;
    const d = _istDayStr(c.time);
    let arr = m.get(d);
    if (!arr) { arr = []; m.set(d, arr); }
    arr.push(c);
  }
  for (const arr of m.values()) arr.sort((a, b) => a.time - b.time);
  return m;
}

/** The bar covering a given IST minute-of-day, or null. */
function barAtMinute(bars, mins) {
  if (!Array.isArray(bars)) return null;
  for (const b of bars) if (_istMins(b.time) === mins) return b;
  return null;
}

// ── The per-day simulation (pure — no I/O, unit-testable) ────────────────────
/**
 * Run one session.
 *
 * @param {object} day
 *   { dateStr, spotBars, ladder:[{strike,side,steps,moneyness,symbol,bars}] }
 * @param {object} cfg  strategy.getConfig()
 * @param {number} qty  lot quantity
 * @returns {{ trade:object|null, audit:object }}
 */
function simulateDay(day, cfg, qty) {
  const slip  = _slippagePts();
  const audit = {
    date: day.dateStr,
    spot: null, atm: null, expiryCode: day.expiryCode || null,
    quoted: 0, ladderSize: (day.ladder || []).length,
    ce: null, pe: null,
    outcome: "no_data", note: "",
  };

  const selBar = barAtMinute(day.spotBars, cfg.selectionMin);
  // The open of that bar IS the spot the ATM strike is rounded off. A bar
  // carrying no usable open would round to a NaN strike and name contracts that
  // do not exist, so it is refused the same way the live route refuses to select
  // without an index price.
  if (!selBar || !strategy._px(selBar.open)) {
    audit.note = selBar
      ? `the ${strategy._fmtMins(cfg.selectionMin)} NIFTY index bar carries no usable open — the ATM strike cannot be derived`
      : `no NIFTY index bar at ${strategy._fmtMins(cfg.selectionMin)}`;
    return { trade: null, audit };
  }
  const spot = selBar.open;
  audit.spot = strategy._r2(spot);
  const atm = instrumentConfig.calcATMStrike(spot);
  audit.atm = atm;

  const rungs = (day.ladder || []).map(r => {
    const b = barAtMinute(r.bars, cfg.selectionMin);
    return { ...r, ltp: b ? b.open : null };
  });
  audit.quoted = rungs.filter(r => strategy._px(r.ltp)).length;
  if (!audit.quoted) {
    audit.outcome = "no_data";
    audit.note = "no option premiums for this session — the contract is delisted or the token returned nothing";
    return { trade: null, audit };
  }

  const picked = strategy.selectWatchlist(rungs, atm, cfg);
  const legs = {};
  for (const side of ["CE", "PE"]) {
    const p = side === "CE" ? picked.ce : picked.pe;
    if (!p) continue;
    const src = rungs.find(r => r.symbol === p.symbol);
    legs[side] = { ...p, bars: (src && src.bars) || [] };
    audit[side.toLowerCase()] = { strike: p.strike, ltp: p.ltp, dist: p.dist, moneyness: p.moneyness, symbol: p.symbol };
  }
  if (!legs.CE && !legs.PE) {
    audit.outcome = "no_watchlist";
    audit.note = (picked.notes.rejected[0] || {}).why || "neither side produced a usable strike";
    return { trade: null, audit };
  }

  // ── Entry: walk the window minute by minute, both legs together ──
  let fill = null;
  for (let m = cfg.entryStartMin; m <= cfg.entryEndMin && !fill; m++) {
    const cands = [];
    for (const side of ["CE", "PE"]) {
      const leg = legs[side];
      if (!leg) continue;
      const b = barAtMinute(leg.bars, m);
      // Both ends are needed: the HIGH decides whether the level broke, the OPEN
      // prices the fill. A bar with no usable open would fill at NaN, and a NaN
      // fill computes NO stop at all — an entry with the risk switched off.
      if (!b || !strategy._px(b.high) || !strategy._px(b.open)) continue;
      if (!(b.high > cfg.triggerPremium)) continue;
      // The trigger level on an intrabar cross; the open when the bar started
      // above it. Never better than either.
      const px = Math.max(b.open, cfg.triggerPremium);
      cands.push({ side, leg, bar: b, px });
    }
    if (!cands.length) continue;
    // Both legs above in the same minute → the one further through the level,
    // matching the live route's tie-break.
    cands.sort((a, b) => b.px - a.px);
    fill = cands[0];
  }

  if (!fill) {
    audit.outcome = "no_trigger";
    const peaks = [];
    for (const side of ["CE", "PE"]) {
      const leg = legs[side];
      if (!leg) continue;
      let hi = null;
      for (let m = cfg.entryStartMin; m <= cfg.entryEndMin; m++) {
        const b = barAtMinute(leg.bars, m);
        if (b && strategy._px(b.high) && (hi == null || b.high > hi)) hi = b.high;
      }
      peaks.push(`${side} ${leg.strike} peaked ₹${hi != null ? strategy._r2(hi) : "—"}`);
    }
    audit.note = `neither leg traded above ₹${cfg.triggerPremium} by ${strategy._fmtMins(cfg.entryEndMin)} (${peaks.join(" · ")})`;
    return { trade: null, audit };
  }

  const side      = fill.side;
  const leg       = fill.leg;
  const entryBar  = fill.bar;
  const entryPx   = strategy._r2(fill.px + slip);          // slippage paid UP on a buy
  const initStop  = strategy.computeInitialStop(entryPx, cfg);

  let stop     = initStop;
  let peak     = entryPx;
  let trough   = entryPx;
  let expanded = false;
  let trailMoves = 0;

  const entryMin = _istMins(entryBar.time);
  const bars = leg.bars.filter(b => b.time >= entryBar.time).sort((a, b) => a.time - b.time);
  let exitPx = null, exitReason = null, exitKind = null, exitTime = null;

  for (const b of bars) {
    const m = _istMins(b.time);
    // The price an open-filled exit books. On the ENTRY bar the open printed
    // BEFORE the fill — it is not a price this trade could ever have exited at —
    // so the fill itself stands in for it, and the gap-through test below is left
    // to the bar LOW (which fills at the stop, the honest worst case). `_px` is
    // then what keeps a null open out of every comparison: `null <= stop` is
    // `0 <= stop`, which would square the trade off at ₹0.
    const openPx  = b.time === entryBar.time ? fill.px : b.open;
    const hasOpen = strategy._px(openPx);

    // a. EOD
    if (hasOpen && m >= cfg.forcedExitMin) {
      exitPx = openPx; exitKind = "EOD";
      exitReason = `EOD square-off (${strategy._fmtMins(cfg.forcedExitMin)} IST) — premium ₹${strategy._r2(openPx)}`;
      exitTime = b.time; break;
    }
    // b. gapped through the stop
    if (hasOpen && strategy._num(stop) && openPx <= stop) {
      exitPx = openPx; exitKind = trailMoves ? "TRAIL" : "STOP";
      exitReason = `${trailMoves ? "Trailing stop" : "Stop"} gapped through — the bar opened at ₹${strategy._r2(openPx)}, below the ₹${strategy._r2(stop)} stop`;
      exitTime = b.time; break;
    }
    // c. the 09:45 box, judged on everything BEFORE this bar. Mirrors the
    //    engine's guard: a position opened at or after the check was never given
    //    its fifteen minutes, so the box does not apply to it. Out of the box
    //    the windows cannot overlap; both are settable.
    if (hasOpen && m >= cfg.sidewaysMin && entryMin < cfg.sidewaysMin && !expanded) {
      exitPx = openPx; exitKind = "SIDEWAYS";
      exitReason = `Sideways exit at ${strategy._fmtMins(cfg.sidewaysMin)} — premium never left ₹${cfg.bandDown}–₹${cfg.bandUp} (ranged ₹${strategy._r2(trough)}–₹${strategy._r2(peak)}), closed at ₹${strategy._r2(openPx)}`;
      exitTime = b.time; break;
    }
    // d. the adverse extreme, BEFORE the favourable one
    if (strategy._px(b.low) && b.low < trough) trough = strategy._r2(b.low);
    if (strategy.isExpanded(peak, trough, cfg)) expanded = true;
    if (strategy._num(stop) && strategy._px(b.low) && b.low <= stop) {
      exitPx = stop; exitKind = trailMoves ? "TRAIL" : "STOP";
      exitReason = `${trailMoves ? "Trailing stop" : "Stop"} hit — the bar traded down to ₹${strategy._r2(b.low)}, through the ₹${strategy._r2(stop)} stop`;
      exitTime = b.time; break;
    }
    // e. the favourable extreme, then ratchet
    if (strategy._px(b.high) && b.high > peak) peak = strategy._r2(b.high);
    if (strategy.isExpanded(peak, trough, cfg)) expanded = true;
    const next = strategy.computeTrailStop(peak, initStop, cfg);
    if (strategy._num(next) && next > stop) { stop = next; trailMoves++; }
  }

  if (exitPx == null) {
    // The series ran out before any exit fired — the contract stopped printing.
    const last = bars.length ? bars[bars.length - 1] : entryBar;
    // A last bar with no usable close prices the exit at the fill rather than at
    // NaN or ₹0 — one unreadable candle must not book a total loss, nor poison
    // every aggregate on the results page.
    const lastPx = strategy._px(last.close) ? last.close : entryPx;
    exitPx = lastPx; exitKind = "DATA_END";
    exitReason = `Option series ended at ${_hhmmss(last.time)} before any exit fired — closed on the last printed premium ₹${strategy._r2(lastPx)}`;
    exitTime = last.time;
  }

  // The three open-priced exit branches break BEFORE folding their bar into
  // peak/trough, so the recorded extremes would stop one bar short of the exit —
  // paper folds the exiting tick in. No decision reads these (the box was
  // already judged), but MAE/MFE and bestOptionLtp/worstOptionLtp in the exports
  // are read by the analytics screens, so record what actually happened.
  if (strategy._px(exitPx)) {
    if (exitPx > peak)   peak = strategy._r2(exitPx);
    if (exitPx < trough) trough = strategy._r2(exitPx);
  }

  const exitFilled = strategy._r2(Math.max(0, exitPx - slip));   // slippage given up on a sell
  const charges = getCharges({ broker: "zerodha", isFutures: false, entryPremium: entryPx, exitPremium: exitFilled, qty });
  const pnl = parseFloat(((exitFilled - entryPx) * qty - charges).toFixed(2));

  audit.outcome = "trade";
  audit.note = `${side} ${leg.strike} · ${exitKind}`;

  const trade = {
    // backtestUI's own shape
    entry:      _ts(entryBar.time),
    exit:       _ts(exitTime),
    entryTs:    entryBar.time,
    exitTs:     exitTime,
    side,
    ePrice:     entryPx,
    xPrice:     exitFilled,
    sl:         initStop,
    pnl,
    entryReason: `${side} ${leg.strike} (${leg.moneyness}, picked at ₹${leg.ltp}) traded above ₹${cfg.triggerPremium}`,
    reason:     exitReason,
    // SIMPLE_9:30 columns
    strike:     leg.strike,
    symbol:     leg.symbol,
    moneyness:  leg.moneyness,
    selLtp:     leg.ltp,
    stop:       stop,
    trailMoves,
    peak, trough,
    expanded:   expanded ? "yes" : "no",
    exitKind,
    qty,
    charges,
    held:       `${Math.round((exitTime - entryBar.time) / 60)}m`,
    date:       day.dateStr,
    // canonical option fields, so exports read like every other strategy's
    optionEntryLtp: entryPx,
    optionExitLtp:  exitFilled,
    optionStrike:   leg.strike,
    optionType:     side,
    broker:         "zerodha",
  };
  return { trade, audit };
}

// ── Job body ─────────────────────────────────────────────────────────────────
/** Position size — the same rule the paper route applies. */
function simpleLotQty() {
  const base = instrumentConfig.getLotQty();
  const raw  = parseInt(process.env.SIMPLE930_LOT_MULTIPLIER || "0", 10);
  if (!Number.isFinite(raw) || raw <= 0) return base;
  let maxMult = parseInt(process.env.MAX_LOT_MULTIPLIER || "10", 10);
  if (!Number.isFinite(maxMult) || maxMult < 1) maxMult = 10;
  let globalMult = parseInt(process.env.LOT_MULTIPLIER || "1", 10);
  if (!Number.isFinite(globalMult) || globalMult <= 0) globalMult = 1;
  if (globalMult > maxMult) globalMult = maxMult;
  return Math.round((base / globalMult) * Math.min(raw, maxMult));
}

/** IST calendar days in [from, to], clamped to today, weekends dropped. */
function tradingDaysIn(from, to, todayStr) {
  const out = [];
  const start = new Date(`${from}T00:00:00Z`);
  let   end   = new Date(`${to}T00:00:00Z`);
  const today = new Date(`${todayStr}T00:00:00Z`);
  if (isNaN(start.getTime()) || isNaN(end.getTime())) return out;
  if (end > today) end = today;
  for (let d = new Date(start); d <= end; d = new Date(d.getTime() + 86400000)) {
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

/** The window the CURRENT weekly contract can actually serve. */
async function currentContractWindow(todayStr) {
  const exp = await weeklyExpiryOnOrAfter(todayStr);
  if (!exp) return { from: todayStr, to: todayStr, code: null };
  // A weekly contract is listed for far longer than its own week, but the range
  // that is BOTH listed and already traded is "this week so far".
  const utcToday = new Date(`${todayStr}T00:00:00Z`);
  const back = (utcToday.getUTCDay() + 6) % 7;   // back to Monday
  const mon = new Date(utcToday.getTime() - back * 86400000);
  return { from: mon.toISOString().slice(0, 10), to: todayStr, code: exp.code };
}

async function runJob(id, from, to) {
  const cfg = strategy.getConfig();
  const qty = simpleLotQty();
  const todayStr = _todayStr();
  const days = tradingDaysIn(from, to, todayStr);
  if (!days.length) {
    const win = await currentContractWindow(todayStr);
    backtestJobs.failJob(id, from > todayStr
      ? `${from} → ${to} is in the future — there is no option history for a session that has not happened yet. Try ${ENDPOINT}?from=${win.from}&to=${win.to}.`
      : `No weekday sessions in ${from} → ${to}.`);
    return;
  }

  // ── Phase 1: the index series, and each day's ATM + expiry ──
  backtestJobs.updateProgress(id, { phase: `Fetching NIFTY index ${RES}-min candles (${days.length} session(s))…`, pct: 5 });
  let spotAll = [];
  try {
    spotAll = await fetchCandles(SPOT_SYMBOL, RES, days[0], days[days.length - 1]);
  } catch (err) {
    backtestJobs.failJob(id, `NIFTY index history failed: ${fyersErrText(err)}. An expired Fyers token returns no data rather than an auth error — log in again and retry.`);
    return;
  }
  const spotByDay = byDay(spotAll);
  if (!spotByDay.size) {
    backtestJobs.failJob(id, `Fyers returned no NIFTY index candles for ${from} → ${to}. Most often the Fyers session needs re-login — an expired token returns no data (not an auth error).`);
    return;
  }

  const plans = [];              // per-day { dateStr, spotBars, atm, expiry, rungs }
  const needed = new Map();      // symbol → { strike, side, steps, moneyness }
  for (const dateStr of days) {
    const spotBars = spotByDay.get(dateStr);
    if (!spotBars || !spotBars.length) { plans.push({ dateStr, spotBars: null, skip: "no index candles (market holiday, or outside the served window)" }); continue; }
    const selBar = barAtMinute(spotBars, cfg.selectionMin);
    // No usable open ⇒ no spot ⇒ no ATM. Naming rungs off a NaN strike would ask
    // Fyers for contracts that do not exist and burn the whole run on refusals.
    if (!selBar || !strategy._px(selBar.open)) { plans.push({ dateStr, spotBars, skip: `no usable index bar at ${strategy._fmtMins(cfg.selectionMin)}` }); continue; }
    const exp = await weeklyExpiryOnOrAfter(dateStr);
    if (!exp) { plans.push({ dateStr, spotBars, skip: "could not resolve the weekly expiry" }); continue; }
    const atm = instrumentConfig.calcATMStrike(selBar.open);
    const rungs = strategy.buildCandidateStrikes(atm, cfg).map(c => ({
      ...c, symbol: strategy.optionSymbol(exp.code, c.strike, c.side),
    }));
    for (const r of rungs) if (!needed.has(r.symbol)) needed.set(r.symbol, r);
    plans.push({ dateStr, spotBars, atm, expiryCode: exp.code, expiryDate: exp.dateStr, rungs });
  }

  const symbols = Array.from(needed.keys());
  if (!symbols.length) {
    backtestJobs.failJob(id, `No option contracts could be named for ${from} → ${to} — every session was missing its ${strategy._fmtMins(cfg.selectionMin)} index bar.`);
    return;
  }

  // ── Phase 2: one 1-min series per contract, across the whole range ──
  const seriesBySymbol = new Map();
  const refused = [];
  for (let i = 0; i < symbols.length; i++) {
    const sym = symbols[i];
    backtestJobs.updateProgress(id, {
      phase: `Fetching option premiums — ${sym} (${i + 1}/${symbols.length})…`,
      pct: 10 + Math.round((i / symbols.length) * 75),
    });
    try {
      const rows = await fetchCandles(sym, RES, days[0], days[days.length - 1]);
      if (Array.isArray(rows) && rows.length) seriesBySymbol.set(sym, byDay(rows));
      else refused.push({ symbol: sym, error: "no candles returned (contract not listed for this range, or an expired token)" });
    } catch (err) {
      const msg = fyersErrText(err);
      refused.push({ symbol: sym, error: /Invalid symbol/i.test(msg) ? "contract expired — Fyers no longer lists it" : msg.slice(0, 160) });
    }
  }

  if (!seriesBySymbol.size) {
    const win = await currentContractWindow(todayStr);
    const allDelisted = refused.length > 0 && refused.every(r => /expired|not listed/i.test(r.error));
    backtestJobs.failJob(id,
      allDelisted
        ? `Not one option contract in ${from} → ${to} is still listed — a NIFTY weekly option is DELISTED the moment it expires, so its premium history can never be fetched again. This strategy can only be backtested over contracts that still exist. Try ${ENDPOINT}?from=${win.from}&to=${win.to}.`
        : `Fyers served no option candles for ${from} → ${to}. First reason given: ${(refused[0] || {}).error || "unknown"}. "Could not authenticate the user" means the Fyers session needs re-login; an expired token returns no data rather than an auth error.`);
    return;
  }

  // ── Phase 3: simulate each day ──
  backtestJobs.updateProgress(id, { phase: `Simulating ${plans.length} session(s)…`, pct: 90 });
  const trades = [];
  const dayLog = [];
  for (const p of plans) {
    if (p.skip) { dayLog.push({ date: p.dateStr, outcome: "skipped", note: p.skip }); continue; }
    const ladder = p.rungs.map(r => {
      const perDay = seriesBySymbol.get(r.symbol);
      return { ...r, bars: (perDay && perDay.get(p.dateStr)) || [] };
    });
    const { trade, audit } = simulateDay({ dateStr: p.dateStr, spotBars: p.spotBars, ladder, expiryCode: p.expiryCode }, cfg, qty);
    dayLog.push(audit);
    if (trade) trades.push(trade);
  }
  trades.sort((a, b) => a.entryTs - b.entryTs);

  const stats = computeBacktestStats(trades);
  stats.optionSim = false;   // real option candles — NOT a delta/theta model

  try { saveResult(RESULT_KEY, { summary: stats, params: { from, to, resolution: RES } }); }
  catch (e) { console.warn("[simple930-backtest] saveResult failed:", e.message); }

  backtestJobs.completeJob(id, {
    trades, stats, from, to,
    meta: { days: plans.length, dayLog, refused, contracts: seriesBySymbol.size, symbolsAsked: symbols.length, qty },
  });
  console.log(`✅ SIMPLE_9:30 Backtest job ${id} complete — ${trades.length} trade(s) over ${plans.length} session(s), ${seriesBySymbol.size}/${symbols.length} contracts served`);
}

// ── Results page ─────────────────────────────────────────────────────────────
function _renderResults(res, from, to, trades, stats, meta) {
  const inf = (x) => x === Infinity ? "∞" : x;
  const cfg = strategy.getConfig();
  const dayLog  = meta.dayLog || [];
  const counts  = dayLog.reduce((a, d) => { a[d.outcome] = (a[d.outcome] || 0) + 1; return a; }, {});
  const refused = meta.refused || [];

  const noTradeRows = dayLog.filter(d => d.outcome !== "trade");
  const shown = noTradeRows.slice(0, 12);
  const dayNote = noTradeRows.length
    ? `<br><br><b>Sessions with no trade (${noTradeRows.length}):</b> ` +
      shown.map(d => `<code>${escHtml(d.date)}</code> ${escHtml(d.note || d.outcome)}`).join(" · ") +
      (noTradeRows.length > shown.length ? ` … and ${noTradeRows.length - shown.length} more — the full per-session audit is at <code>${ENDPOINT}/day-log?jobId=…</code>` : "")
    : "";

  const coverage = refused.length
    ? `<b style="color:#f59e0b;">⚠ Partial coverage — ${refused.length} of ${meta.symbolsAsked} contract(s) could not be fetched:</b> ` +
      refused.slice(0, 8).map(r => `<code>${escHtml(r.symbol)}</code> (${escHtml(r.error)})`).join(", ") +
      (refused.length > 8 ? `, and ${refused.length - 8} more` : "") +
      `. Those rungs are simply ABSENT from the 09:25 ladder on the days that needed them — not priced at zero. `
    : `All ${meta.contracts} contract(s) asked for were served. `;

  const html = renderBacktestResults({
    mode: "SIMPLE930",
    accent: ACCENT,
    strategyName: strategy.NAME,
    endpoint: ENDPOINT,
    from, to,
    summary: stats,
    trades,
    activePage: "simple930Backtest",
    extraTradeColumns: [
      { key: "strike",     label: "Strike" },
      { key: "moneyness",  label: "ITM/ATM" },
      { key: "selLtp",     label: "₹ @ 09:25" },
      { key: "peak",       label: "Peak ₹" },
      { key: "trailMoves", label: "Trail ×" },
      { key: "expanded",   label: "Left box" },
      { key: "exitKind",   label: "Exit" },
      { key: "held",       label: "Held" },
    ],
    extraStats: [
      { label: "Profit Factor",       value: inf(stats.profitFactor) },
      { label: "Expectancy /trade",   value: `₹${stats.expectancy}` },
      { label: "Max Drawdown",        value: `₹${stats.maxDrawdown}` },
      { label: "Sessions scanned",    value: meta.days },
      { label: "Sessions traded",     value: counts.trade || 0 },
      { label: "No leg cleared ₹" + cfg.triggerPremium, value: counts.no_trigger || 0 },
      { label: "No watchlist formed", value: counts.no_watchlist || 0 },
      { label: "No option data",      value: (counts.no_data || 0) + (counts.skipped || 0) },
      { label: "Stopped / trailed out", value: trades.filter(t => t.exitKind === "STOP" || t.exitKind === "TRAIL").length },
      { label: "09:45 sideways exits", value: trades.filter(t => t.exitKind === "SIDEWAYS").length },
      { label: "Ran to EOD",          value: trades.filter(t => t.exitKind === "EOD").length },
      { label: "Trade frequency",     value: meta.days ? `${(((counts.trade || 0) / meta.days) * 100).toFixed(1)}% of sessions` : "—" },
    ],
    notes: `${coverage}<b>Premiums are REAL:</b> every price here is a 1-minute candle Fyers printed for the option contract the rule would have held — there is no delta model and no theta model, because on this strategy that would be simulating the strategy itself. ` +
      `<b>Selection:</b> at ${strategy._fmtMins(cfg.selectionMin)} the ladder is ${cfg.scanItmStrikes} ITM${cfg.scanOtmStrikes ? ` + ${cfg.scanOtmStrikes} OTM` : ""} strikes per side and the strike nearest ₹${cfg.triggerPremium} is kept on each side. ` +
      `<b>Entry:</b> the first watchlist leg whose 1-min bar trades above ₹${cfg.triggerPremium} between ${strategy._fmtMins(cfg.entryStartMin)} and ${strategy._fmtMins(cfg.entryEndMin)}, filled at max(bar open, ₹${cfg.triggerPremium}). ` +
      `<b>Exits:</b> ${cfg.slPts}pt stop off the fill${cfg.trailEnabled ? `, trailing ${cfg.trailPts}pt behind the peak` : " (trail OFF)"}; at ${strategy._fmtMins(cfg.sidewaysMin)} a trade still inside ₹${cfg.bandDown}–₹${cfg.bandUp} is closed; EOD ${strategy._fmtMins(cfg.forcedExitMin)}. ` +
      `<b>Intra-bar ordering is conservative:</b> the stop is tested on the bar low BEFORE the trail is lifted from the bar high, a bar that opened beyond the stop fills at the open, and the entry bar is tested like any other. ` +
      (cfg.sustainPolls > 1
        ? `<b style="color:#f59e0b;">⚠ SIMPLE930_SUSTAIN_POLLS is set to ${cfg.sustainPolls}, and this page cannot model it</b> — "N consecutive quotes above the trigger" has no meaning on a 1-minute bar, so the backtest fills on the first bar that crosses and will report MORE entries than paper would take. `
        : "") +
      (Number(process.env.SIMPLE930_MAX_DAILY_TRADES || "1") > 1
        ? `<b style="color:#f59e0b;">⚠ SIMPLE930_MAX_DAILY_TRADES is set to ${process.env.SIMPLE930_MAX_DAILY_TRADES}, and this page takes at most ONE trade a session regardless</b> — it will report FEWER entries than paper would take. `
        : "") +
      `<b>The stop fill is the backtest's one systematic flattery:</b> it books exactly the stop level, while paper books the tick that breached it. The slippage haircut offsets part of that, not all of it. ` +
      `Slippage of ${_slippagePts()}pt is charged EACH way and Zerodha statutory charges are applied on ${meta.qty} qty. ` +
      `<b>A NIFTY weekly option is delisted at expiry</b>, so sessions older than the listed contracts cannot be fetched at all — they show as "no option data", not as flat days. ` +
      `<b>This strategy has NEVER traded live or on paper. Nothing here is validated.</b>${dayNote}`,
  });
  res.send(html);
}

// ── Routes ───────────────────────────────────────────────────────────────────
router.get("/status", (req, res) => {
  const job = backtestJobs.getJob(req.query.jobId);
  if (!job) return res.json({ status: "not_found" });
  res.json({ status: job.status, progress: job.progress, elapsed: Date.now() - job.startedAt, error: job.error });
});

router.get("/idle", (req, res) => {
  if (req.accepts(["json", "html"]) === "json" || req.query.json === "1") return res.json({ idle: backtestJobs.isIdle() });
  return res.redirect(ENDPOINT);
});

/** The full per-session audit — every day, traded or not, with the reason. */
router.get("/day-log", (req, res) => {
  const job = backtestJobs.getJob(req.query.jobId);
  if (!job || !job.result) return res.status(404).json({ error: "no finished job with that id" });
  const meta = job.result.meta || {};
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.send(JSON.stringify({
    strategy: strategy.NAME,
    from: job.result.from, to: job.result.to,
    config: strategy.getConfig(),
    sessions: meta.dayLog || [],
    unfetchableContracts: meta.refused || [],
    trades: job.result.trades || [],
  }, null, 2));
});

router.get("/", async (req, res) => {
  let { from, to } = req.query;
  if (!from || !to) {
    // NOT the repo-standard 90 days: a NIFTY weekly option is delisted at expiry,
    // so a 90-day default would open on contracts that no longer exist. Default
    // to this week — the range Fyers is most likely to serve.
    const win = await currentContractWindow(_todayStr());
    return res.redirect(`${ENDPOINT}?from=${win.from}&to=${win.to}`);
  }

  const jobId = req.query.jobId;
  if (!jobId) {
    const activeJob = backtestJobs.getActiveJob();
    if (activeJob) return res.send(backtestJobs.buildQueuePage(ENDPOINT, "SIMPLE_9:30 Backtest"));
    const { id } = backtestJobs.createJob("simple930");
    (async () => {
      try {
        console.log(`🔍 SIMPLE_9:30 Backtest job ${id}: ${from} → ${to}`);
        await runJob(id, from, to);
      } catch (err) {
        console.error("[simple930-backtest] job error:", err);
        backtestJobs.failJob(id, err.message);
      }
    })();
    return res.send(backtestJobs.buildProgressPage(id, ENDPOINT, "SIMPLE_9:30 Backtest"));
  }

  const job = backtestJobs.getJob(jobId);
  if (!job) return res.redirect(ENDPOINT);
  if (job.status === "running") return res.send(backtestJobs.buildProgressPage(jobId, ENDPOINT, "SIMPLE_9:30 Backtest"));
  if (job.status === "error")   return res.status(500).send(renderErrorPage(job.error, from, to));
  const { trades, stats, meta } = job.result;
  return _renderResults(res, from, to, trades, stats, meta || { days: 0, dayLog: [], refused: [] });
});

function _errLightAttr() {
  return require("../utils/theme").resolveTheme() === "light" ? ' data-theme="light"' : "";
}

function renderErrorPage(msg, from, to) {
  return `<!DOCTYPE html><html${_errLightAttr()}><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>${faviconLink()}<title>SIMPLE_9:30 Backtest Error</title>
<style>body{font-family:'IBM Plex Mono',monospace;background:#060810;color:#a0b8d8;padding:40px;text-align:center;}
h2{color:#ef4444;margin-bottom:12px;}p{margin-bottom:18px;line-height:1.7;max-width:720px;margin-left:auto;margin-right:auto;}
a{color:${ACCENT};text-decoration:none;border:0.5px solid #0e1428;padding:8px 14px;border-radius:6px;}
:root[data-theme="light"] body{background:#f4f6f9;color:#334155;}
:root[data-theme="light"] h2{color:#b91c1c;}
:root[data-theme="light"] a{border-color:#e0e4ea;background:#ffffff;color:#b45309;}
@media(max-width:768px){body{padding:24px 14px;}a{min-height:44px;display:inline-flex;align-items:center;justify-content:center;}}</style>
</head><body><h2>SIMPLE_9:30 Backtest Failed</h2><p>${escHtml(msg)}</p><p><b>${escHtml(from || "")}</b> → <b>${escHtml(to || "")}</b></p><a href="${ENDPOINT}">← Back</a></body></html>`;
}

module.exports = router;
// Exposed for offline unit-testing of the day simulation (no Fyers needed).
module.exports.simulateDay = simulateDay;
module.exports.tradingDaysIn = tradingDaysIn;
module.exports.weeklyExpiryOnOrAfter = weeklyExpiryOnOrAfter;
module.exports.barAtMinute = barAtMinute;
module.exports.byDay = byDay;

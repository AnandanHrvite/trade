// Shared live/paper-trade guards: bid-ask spread filter at entry, time-stop at exit.
// Keeps paper and live engines aligned on real-market frictions the backtest ignores.

const tickRecorder = require("./tickRecorder");

// Read thresholds LIVE from process.env on each call — not frozen at require()
// time. Previously these were module-load constants, so a Settings edit only
// took effect after a full process restart (the Settings UI wrongly labelled it
// "session restart"). Live reads make the toggle apply on the next entry check.
function liveMaxSpreadPts()      { return parseFloat(process.env.MAX_BID_ASK_SPREAD_PTS || "2"); }
function liveTimeStopCandles()   { return parseInt(process.env.TIME_STOP_CANDLES || "4", 10); }
function liveTimeStopFlatPts()   { return parseFloat(process.env.TIME_STOP_FLAT_PTS || "20"); }

async function fetchOptionQuote(fyers, symbol) {
  try {
    const response = await fyers.getQuotes([symbol]);
    if (response && response.s === "ok" && response.d && response.d.length > 0) {
      const v = response.d[0].v || response.d[0];
      const ltp = Number(
        v.lp || v.ltp || v.last_price || v.last_traded_price ||
        v.ask_price || v.bid_price || v.close_price || v.prev_close_price || 0
      );
      const bid = Number(v.bid || v.bid_price || 0);
      const ask = Number(v.ask || v.ask_price || 0);
      if (ltp > 0) {
        // Capture the entry-time bid/ask so tick-replay can reproduce the spread
        // gate. No-op'd during replay by the harness (so it never writes back).
        try { tickRecorder.recordOptionQuote(symbol, ltp, bid, ask, "spread-guard"); } catch (_) {}
        return { ltp, bid, ask };
      }
    }
  } catch (_) { /* swallow — caller fail-opens */ }
  return null;
}

// Returns { ok, spread, reason }. Fails OPEN (ok=true) if bid/ask unavailable —
// we don't want to starve live trading when the broker snapshot lacks depth fields.
function checkSpread(bid, ask, maxSpreadPts = liveMaxSpreadPts()) {
  if (!bid || !ask || ask <= 0 || bid <= 0 || ask < bid) {
    return { ok: true, spread: null, reason: "no-quote" };
  }
  const spread = parseFloat((ask - bid).toFixed(2));
  return { ok: spread <= maxSpreadPts, spread, reason: `bid=${bid} ask=${ask} spread=${spread}pt` };
}

// ── Indicator history depth (shared by EMA_RSI_ST paper / live / backtest) ──
// One source of truth for the rolling candle window each engine feeds to
// getSignal(). Previously each engine hard-coded `> 200` in its own file.
//
// Chosen from measurement, not judgement. Comparing getSignal() over a rolling
// 200-candle window against paper's real ~1,125-candle window on 1,500 live
// NIFTY 5-min candles (April 2026): 0 signal differences, 0 SuperTrend trend or
// value differences, 0 RSI differences; only EMA50 drifted, by at most 0.12 pt.
// Sweeping the depth, disagreement first appears BELOW ~150 candles (100 → 6
// disagreements, 150 → 0). 400 therefore sits ~2.7× past the measured
// convergence point while costing only 2× the indicator work of the old 200.
//
// NOTE ON ACTUAL LENGTHS: paper and live pre-load ~21 calendar days at /start,
// so their arrays hold ~1,125 candles at 5-min and this cap never trims them
// (the engines shift one element per push, so a preloaded array stays at its
// preloaded size). The backtest seeds at 30 and grows to exactly this cap. The
// three are therefore NOT equal in length — they are equal in OUTPUT, which is
// what parity requires and what the measurement above verifies.
const INDICATOR_HISTORY_CANDLES = 400;

// ── Protective-stop resolver (shared by EMA_RSI_ST paper / live / backtest) ──
// The strategy seeds the initial stop from the SIGNAL candle's predecessor
// (prev-candle low for CE / high for PE). With the confirmation candle ON,
// entry happens one bar later at the cross of the signal candle's close, so
// that level can end up on the WRONG side of the actual fill — e.g. CE filled
// at 24267.25 with a "stop" at 24276.10, which stops out on the next tick.
//
// This resolver keeps the strategy's structure-based stop exactly as-is
// whenever it is already protective (the overwhelmingly common case) and, only
// when it is not, falls back to the NEAREST-IN-TIME structural extreme that IS
// protective — still a real candle low/high from the same candle series, never
// an ATR / points / percentage / EMA substitute.
//
// Search order (most recent first) is what makes it "nearest structure": the
// newest candle considered is the SIGNAL candle.
//
// SEARCH BOUND — the candle history the caller hands in, nothing invented. That
// is the same rolling series the strategy itself reasons over, so the repair can
// never see a level getSignal could not see. Lengths differ by engine (see
// INDICATOR_HISTORY_CANDLES above: paper/live ~1,125, backtest 400) but the scan
// exits on its first iteration in every realistic case, so depth is irrelevant
// to the result — see the `beforeTime` note.
//
// `beforeTime` (unix seconds, optional) — RACE GUARD. Paper and live call this
// from an async continuation after the option-symbol lookup, so a candle can
// close between the entry decision and this call, appending the ENTRY bar to the
// series. Passing the entry bar's time makes the scan ignore any candle at or
// after it, so the resolver deterministically sees the same candles the entry
// decision saw — the signal candle and older — no matter when it runs. The
// backtest passes the same thing, which is what makes all three identical.
//
// Given that guard, iteration 1 always succeeds when the confirmation candle is
// ON: entry is strictly beyond the signal candle's close, and that candle's
// low (CE) / high (PE) is at or beyond its own close, so it qualifies.
//
// Returns { stopLoss, repaired, reason }.
//   stopLoss null + repaired true → no protective structure exists anywhere in
//   the supplied history. Callers MUST treat that as "cannot open a protected
//   position" rather than opening an unstopped one (see M1 handling in the
//   engines); it is unreachable with the confirmation candle ON.

function isProtectiveStop(side, stopLoss, entryPrice) {
  if (stopLoss == null || entryPrice == null) return false;
  return side === "CE" ? stopLoss < entryPrice : stopLoss > entryPrice;
}

function resolveProtectiveStop({ side, entryPrice, stopLoss, candles, beforeTime }) {
  // No stop seeded → leave it null. Adding one here would be a behaviour change.
  if (stopLoss == null) return { stopLoss: null, repaired: false, reason: null };
  if (!Number.isFinite(entryPrice)) return { stopLoss, repaired: false, reason: null };
  if (isProtectiveStop(side, stopLoss, entryPrice)) {
    return { stopLoss, repaired: false, reason: null };
  }

  const series = Array.isArray(candles) ? candles : [];
  const cutoff = Number.isFinite(beforeTime) ? beforeTime : null;
  const limit  = series.length; // the strategy's own window — see note above
  for (let i = 1; i <= limit; i++) {
    const c = series[series.length - i];
    if (!c) continue;
    // Race guard: never consider the entry bar or anything after it.
    // FAIL CLOSED — a candle we cannot timestamp cannot be PROVEN to predate the
    // entry bar, so it must not be used as structure. (It previously fell through
    // and was accepted, which would have let the entry bar itself become the stop:
    // look-ahead in the backtest, wrong candle in paper/live.)
    if (cutoff != null && (c.time == null || !Number.isFinite(c.time) || c.time >= cutoff)) continue;
    const level = side === "CE" ? c.low : c.high;
    if (level == null || !Number.isFinite(level)) continue;
    if (isProtectiveStop(side, level, entryPrice)) {
      const fixed = parseFloat(level.toFixed(2));
      return {
        stopLoss: fixed,
        repaired: true,
        reason: `initial SL ₹${stopLoss} was not protective for ${side} @ ₹${entryPrice} — using nearest structural ${side === "CE" ? "low" : "high"} ₹${fixed} (${i} candle${i > 1 ? "s" : ""} back)`,
      };
    }
  }

  return {
    stopLoss: null,
    repaired: true,
    reason: `initial SL ₹${stopLoss} was not protective for ${side} @ ₹${entryPrice} and no protective structural level exists in the strategy's ${limit}-candle history — entering with no initial structural stop`,
  };
}

// Returns an exit-reason string if the time-stop should fire, else null.
// Fires only when the trade has been held >= maxCandles AND option-premium PnL
// is still within ±flatPts (i.e., no meaningful move — pure theta bleed risk).
function checkTimeStop(candlesHeld, pnlPts, {
  maxCandles = liveTimeStopCandles(),
  flatPts    = liveTimeStopFlatPts(),
} = {}) {
  if (!Number.isFinite(candlesHeld) || candlesHeld < maxCandles) return null;
  if (!Number.isFinite(pnlPts))                                 return null;
  if (Math.abs(pnlPts) >= flatPts)                              return null;
  const sign = pnlPts >= 0 ? "+" : "";
  return `Time-stop — flat after ${candlesHeld} candles (${sign}${pnlPts.toFixed(1)}pt)`;
}

module.exports = {
  fetchOptionQuote,
  checkSpread,
  checkTimeStop,
  isProtectiveStop,
  resolveProtectiveStop,
  INDICATOR_HISTORY_CANDLES,
  // Live getters (kept under the old names for callers that read them for display).
  get DEFAULT_MAX_SPREAD_PTS()     { return liveMaxSpreadPts(); },
  get DEFAULT_TIME_STOP_CANDLES()  { return liveTimeStopCandles(); },
  get DEFAULT_TIME_STOP_FLAT_PTS() { return liveTimeStopFlatPts(); },
};

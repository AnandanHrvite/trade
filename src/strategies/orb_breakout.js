/**
 * ORB — Opening Range Breakout (15-minute opening range, single-leg option buy)
 * ─────────────────────────────────────────────────────────────────────────────
 * The "famous" intraday breakout setup taught in every options course.
 *
 * Setup:
 *   • Build a 15-min "opening range" from the first 9:15–9:30 candles.
 *   • Once range is locked, watch for a 5-min CLOSE outside the range:
 *       — Close above ORH → BUY CE (bullish breakout, ATM strike)
 *       — Close below ORL → BUY PE (bearish breakdown, ATM strike)
 *   • Take ONE trade per session, intraday MIS, square-off at 15:15 IST.
 *
 * Filters:
 *   • Range size sanity: ORH-ORL between ORB_MIN_RANGE_PTS (default 25) and
 *     ORB_MAX_RANGE_PTS (default 120). Too tight = noise. Too wide = exhausted.
 *   • Entry window: 9:30 – ORB_ENTRY_END (default 12:00). Stale breakouts after
 *     noon tend to fade.
 *   • Confirmation candle close OUTSIDE the range (not just a wick).
 *   • Optional retest mode (ORB_REQUIRE_RETEST): wait for price to come back
 *     to the broken level before entering. Off by default — most courses
 *     teach immediate-break entry.
 *
 * Exit (handled by route, not signal file):
 *   • Target: +ORB_TARGET_PCT of premium (default 50%) OR 1.5× range on spot,
 *     whichever first.
 *   • SL: −ORB_STOP_PCT of premium (default 30%) OR spot back inside the
 *     opposite side of the range.
 *   • Trail: once spot moves ≥ 1× range in favour, lift SL to entry (BE).
 *   • Time stop: hard square-off at 15:15 IST.
 *
 * Returns: { signal, side, reason, orh, orl, rangePts, entrySpot, slSpot,
 *            targetSpot, signalStrength }
 *   signal:  "BUY_CE" | "BUY_PE" | "NONE"
 *   strength: STRONG when range size is in the sweet spot (30–80pt) and the
 *             breakout candle body > 15pt. MARGINAL otherwise.
 */

const NAME        = "ORB_15MIN";
const DESCRIPTION = "Opening Range Breakout — 15-min OR, 5-min confirm, ATM CE/PE buying";

function _parseMins(envKey, fallback) {
  const v = (process.env[envKey] || fallback).trim();
  const parts = v.split(":");
  return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
}

function _utcSecToIstMins(unixSec) {
  return Math.floor((unixSec + 19800) / 60) % 1440;
}

/**
 * Compute the opening range from the first 9:15–9:30 candles in `candles`.
 * Returns null if the range cannot yet be determined (still in OR window).
 */
function computeOpeningRange(candles) {
  const rangeStartMin = _parseMins("ORB_RANGE_START", "09:15");
  const rangeEndMin   = _parseMins("ORB_RANGE_END",   "09:30");
  if (!candles || candles.length === 0) return null;

  let high = -Infinity;
  let low  =  Infinity;
  let count = 0;
  for (const c of candles) {
    const m = _utcSecToIstMins(c.time);
    if (m < rangeStartMin) continue;
    if (m >= rangeEndMin)  break;
    if (c.high > high) high = c.high;
    if (c.low  < low)  low  = c.low;
    count++;
  }
  if (count === 0 || high === -Infinity) return null;
  return { high: Math.round(high * 100) / 100, low: Math.round(low * 100) / 100, candleCount: count };
}

/**
 * getSignal(candles, opts) — returns ORB breakout signal on the latest candle.
 *
 * @param {Array<{time, open, high, low, close}>} candles — IST-aware 5-min candles
 * @param {object} [opts]
 *   silent — suppress console.log
 *   alreadyTraded — true if a trade has already been taken this session
 *                   (ORB is once-per-day, so we return NONE early)
 */
function getSignal(candles, opts) {
  const silent = !!(opts && opts.silent);
  const alreadyTraded = !!(opts && opts.alreadyTraded);
  const base = {
    signal:        "NONE",
    side:          null,
    orh:           null,
    orl:           null,
    rangePts:      null,
    entrySpot:     null,
    slSpot:        null,
    targetSpot:    null,
    signalStrength: null,
    reason:        "",
  };

  if (!candles || candles.length < 4) {
    return Object.assign({}, base, { reason: `Warming up (${candles ? candles.length : 0}/4 candles)` });
  }

  // ── Trading window ──────────────────────────────────────────────────────
  const entryStartMin = _parseMins("ORB_RANGE_END",   "09:30");   // entries only after OR is locked
  const entryEndMin   = _parseMins("ORB_ENTRY_END",   "12:00");   // skip stale breakouts after noon
  const last = candles[candles.length - 1];
  const lastIst = _utcSecToIstMins(last.time);
  if (lastIst < entryStartMin) {
    return Object.assign({}, base, { reason: `Building opening range (waiting for ${process.env.ORB_RANGE_END || "09:30"} IST)` });
  }
  if (lastIst >= entryEndMin)  {
    return Object.assign({}, base, { reason: `Past ${process.env.ORB_ENTRY_END || "12:00"} IST — no new ORB entries (stale breakout window)` });
  }

  if (alreadyTraded) {
    return Object.assign({}, base, { reason: "Already traded this session — ORB takes only 1 trade/day" });
  }

  // ── Compute opening range ───────────────────────────────────────────────
  const or = computeOpeningRange(candles);
  if (!or) {
    return Object.assign({}, base, { reason: "Opening range not yet formed" });
  }
  const rangePts = Math.round((or.high - or.low) * 100) / 100;
  const minR = parseFloat(process.env.ORB_MIN_RANGE_PTS || "25");
  const maxR = parseFloat(process.env.ORB_MAX_RANGE_PTS || "120");
  const orBase = Object.assign({}, base, { orh: or.high, orl: or.low, rangePts });
  if (rangePts < minR) {
    return Object.assign({}, orBase, { reason: `Range too tight (${rangePts}pt < ${minR}pt) — likely noise, skip` });
  }
  if (rangePts > maxR) {
    return Object.assign({}, orBase, { reason: `Range too wide (${rangePts}pt > ${maxR}pt) — open already moved, skip` });
  }

  // ── Breakout check on the most recent CLOSED candle ─────────────────────
  // Caller passes already-closed candles. The last element is the candle
  // whose close we evaluate. We require close outside the range, body in the
  // breakout direction, and body >= ORB_MIN_BODY (default 8pt).
  const body = Math.abs(last.close - last.open);
  const minBody = parseFloat(process.env.ORB_MIN_BODY || "8");

  const bullishBreak = last.close > or.high && last.close > last.open && body >= minBody;
  const bearishBreak = last.close < or.low  && last.close < last.open && body >= minBody;

  if (!bullishBreak && !bearishBreak) {
    // Inside-range or weak break — explain briefly
    const aboveH = last.close > or.high;
    const belowL = last.close < or.low;
    let why;
    if (aboveH || belowL) {
      why = `Break ${aboveH ? "above" : "below"} but body too small or against (body=${body.toFixed(1)}pt, min=${minBody}pt)`;
    } else {
      why = `Close ${last.close} inside range [${or.low}, ${or.high}]`;
    }
    return Object.assign({}, orBase, { reason: why });
  }

  // ── Build signal ────────────────────────────────────────────────────────
  const side       = bullishBreak ? "CE" : "PE";
  const entrySpot  = last.close;
  // SL: opposite side of OR (so CE SL = ORL; PE SL = ORH)
  const slSpot     = side === "CE" ? or.low  : or.high;
  // Target: 1.5× range in the breakout direction
  const tgtMult    = parseFloat(process.env.ORB_TARGET_RANGE_MULT || "1.5");
  const targetSpot = side === "CE" ? or.high + rangePts * tgtMult
                                   : or.low  - rangePts * tgtMult;

  // Strength: range in the sweet spot AND body strong → STRONG
  const sweetMin   = parseFloat(process.env.ORB_SWEET_MIN || "30");
  const sweetMax   = parseFloat(process.env.ORB_SWEET_MAX || "80");
  const strongBody = parseFloat(process.env.ORB_STRONG_BODY || "15");
  const strength   = (rangePts >= sweetMin && rangePts <= sweetMax && body >= strongBody) ? "STRONG" : "MARGINAL";

  if (!silent) {
    const istStr = new Date(last.time * 1000).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: false });
    console.log(`[ORB ${istStr}] BREAK ${side} | ORH=${or.high} ORL=${or.low} range=${rangePts}pt | close=${last.close} body=${body.toFixed(1)}pt [${strength}]`);
  }

  return Object.assign({}, orBase, {
    signal:        side === "CE" ? "BUY_CE" : "BUY_PE",
    side,
    entrySpot:     Math.round(entrySpot * 100) / 100,
    slSpot:        Math.round(slSpot * 100) / 100,
    targetSpot:    Math.round(targetSpot * 100) / 100,
    signalStrength: strength,
    reason: `ORB ${side} break (close ${last.close} ${side === "CE" ? ">" : "<"} ${side === "CE" ? "ORH" : "ORL"} ${side === "CE" ? or.high : or.low}, range=${rangePts}pt, body=${body.toFixed(1)}pt) [${strength}]`,
  });
}

module.exports = { NAME, DESCRIPTION, getSignal, computeOpeningRange };

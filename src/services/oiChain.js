/**
 * oiChain.js — LIVE PER-STRIKE OPTION OI (the data layer, not a strategy)
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 * ───────────────
 * Until now the only Open Interest anywhere in this repo was a single scalar:
 * NIFTY current-month FUTURES OI (see oiFilter.js). That is enough for a coarse
 * "is the market building longs or shorts" gate, and nothing more. Every OI idea
 * an option BUYER actually cares about — which strike the writers are defending,
 * where the walls are, whether writers are covering — is per-strike, and this
 * codebase has never had that number.
 *
 * optionChainRecorder already polls the ATM±N CE/PE chain every few seconds for
 * LTP/bid/ask. The OI field was in those very same quote rows and was being
 * thrown away. This module is where it now lands.
 *
 * RELATIONSHIP TO oiFilter.js
 * ───────────────────────────
 * oiFilter = ONE futures number, used as an entry gate by the existing engines.
 * oiChain  = the whole strike ladder, used by /oi-monitor and (later) an OI
 *            strategy. They are independent; nothing here touches oiFilter, and
 *            no existing strategy's behaviour changes because this module exists.
 *
 * DESIGN
 * ──────
 *   - PURE SINK + PURE READS. ingest() is the only mutator; it is called from the
 *     recorder poll. This module never fetches, never places an order, never
 *     touches strategy state.
 *   - Bounded memory. One ring buffer per strike|side, MAX_SAMPLES deep, and the
 *     whole map is dropped when the chain rolls to a new IST day or after a long
 *     gap — a Δ that spans the overnight OI reset is meaningless and dangerous.
 *   - Value-change semantics. The recorder polls far faster than OI updates, so a
 *     sample is only appended when the value actually MOVES. That means "3 samples
 *     back" is 3 real OI updates, not 3 poll ticks — which is the honest unit for
 *     a Δ, and it is what makes a lookback comparable across a fast morning and a
 *     dead afternoon. The trade-off: a lookback is a variable amount of wall-clock
 *     time, so getDeltaOiPct() reports `spanMs` and callers that need a time bound
 *     must check it.
 *
 * WHAT THIS MODULE DELIBERATELY DOES NOT DO
 * ─────────────────────────────────────────
 * It draws no conclusions. No "bullish", no signal, no allow/block. Interpreting
 * a wall or a ΔOI is a strategy's job, and there is no validated strategy yet —
 * per-strike OI history does not exist to backtest against, which is exactly why
 * the recording comes first.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const MAX_SAMPLES  = 40;             // per strike|side — ~40 real OI moves is plenty for a 6-deep lookback
const STALE_GAP_MS = 30 * 60_000;    // gap > 30m (overnight / long pause) ⇒ the whole chain is stale
const STRIKE_STEP  = 50;             // NIFTY

// key = "24500|CE" → { strike, side, samples: [{ ts, oi }] }
let _strikes      = new Map();
let _lastIngestTs = 0;
let _day          = null;

function _istDay(ts) {
  const istSec = Math.floor((ts || Date.now()) / 1000) + 19800;
  return Math.floor(istSec / 86400);
}

/**
 * Split "NSE:NIFTY2580724500CE" → { strike: 24500, side: "CE" }.
 *
 * `expiryCode` is REQUIRED and this returns null without it. That is not
 * defensiveness for its own sake — a WEEKLY expiry code is all digits ("25807"),
 * so it runs straight into the strike digits and there is no way to tell where
 * one ends and the other begins by pattern alone. A greedy match on
 * "NSE:NIFTY2580724500CE" happily yields strike 2,580,724,500. Stripping the
 * known prefix is the only correct split, and refusing to guess is better than
 * a plausible wrong number entering the ladder.
 *
 * Returns null for futures / index / VIX symbols too, so a caller can pass
 * whatever its quote loop happens to hold.
 */
function parseOptionSymbol(symbol, expiryCode) {
  if (typeof symbol !== "string" || !expiryCode) return null;
  const prefix = `NSE:NIFTY${expiryCode}`;
  if (!symbol.startsWith(prefix)) return null;
  const m = /^(\d+)(CE|PE)$/.exec(symbol.slice(prefix.length));
  if (!m) return null;
  const strike = parseInt(m[1], 10);
  if (!Number.isFinite(strike) || strike <= 0) return null;
  return { strike, side: m[2] };
}

const _key = (strike, side) => `${strike}|${side}`;

/**
 * Append one strike's OI observation. Called from optionChainRecorder's poll.
 *
 * Takes strike and side EXPLICITLY rather than a symbol: the recorder already
 * holds both (it built the symbol from them), so passing them through removes
 * the expiry/strike ambiguity above entirely instead of re-deriving it.
 *
 * Cheap and total — never throws, so a malformed row can't break the poll loop.
 */
function ingest(strike, side, oi, ts = Date.now()) {
  if (!(oi > 0) || !(strike > 0)) return;
  if (side !== "CE" && side !== "PE") return;

  // Drop the whole chain across a day boundary or a long gap. Comparing today's
  // OI against yesterday's would read as a colossal unwind — OI resets, it does
  // not continue — and that is precisely the false signal this guard prevents.
  const day = _istDay(ts);
  if (_day !== day || (_lastIngestTs && ts - _lastIngestTs > STALE_GAP_MS)) {
    _strikes = new Map();
    _day = day;
  }
  _lastIngestTs = ts;

  const key = _key(strike, side);
  let rec = _strikes.get(key);
  if (!rec) { rec = { strike, side, samples: [] }; _strikes.set(key, rec); }

  const last = rec.samples[rec.samples.length - 1];
  if (last && last.oi === oi) return;   // no move — the series tracks changes, not polls

  rec.samples.push({ ts, oi });
  if (rec.samples.length > MAX_SAMPLES) rec.samples.splice(0, rec.samples.length - MAX_SAMPLES);
}

/** Latest OI for a strike/side, or null if never seen this session. */
function getStrikeOi(strike, side) {
  const rec = _strikes.get(_key(strike, side));
  if (!rec || !rec.samples.length) return null;
  return rec.samples[rec.samples.length - 1].oi;
}

/**
 * Percent change in a strike's OI over the last `lookback` OI MOVES (not polls).
 *
 * Returns null while the series is too short — an unknown Δ must never be
 * mistaken for a zero Δ, because zero reads as "writers are steady", which is a
 * tradeable claim we have no evidence for.
 *
 * `spanMs` is how much wall-clock the lookback actually covered. Check it: on a
 * quiet afternoon 3 moves can span half an hour, and a Δ over that window means
 * something quite different from the same Δ over three minutes.
 */
function getDeltaOiPct(strike, side, lookback = 3) {
  const rec = _strikes.get(_key(strike, side));
  if (!rec || rec.samples.length < lookback + 1) return null;
  const latest = rec.samples[rec.samples.length - 1];
  const base   = rec.samples[rec.samples.length - 1 - lookback];
  if (!base || !(base.oi > 0)) return null;
  return {
    pct:    ((latest.oi - base.oi) / base.oi) * 100,
    from:   base.oi,
    to:     latest.oi,
    spanMs: latest.ts - base.ts,
  };
}

/**
 * The highest-OI CE and PE strike currently on the ladder — the classic
 * "resistance wall" and "support wall".
 *
 * Read with care: the walls are only meaningful within the band the recorder
 * actually polls (ATM±N). If the true max-OI strike sits outside that band this
 * returns the edge strike and calls it a wall, so `atBandEdge` is set to say so
 * rather than letting a clipped ladder pass as a finding.
 */
function getWalls() {
  let ce = null, pe = null;
  let min = Infinity, max = -Infinity;
  for (const rec of _strikes.values()) {
    if (!rec.samples.length) continue;
    const oi = rec.samples[rec.samples.length - 1].oi;
    if (rec.strike < min) min = rec.strike;
    if (rec.strike > max) max = rec.strike;
    if (rec.side === "CE") { if (!ce || oi > ce.oi) ce = { strike: rec.strike, oi }; }
    else                   { if (!pe || oi > pe.oi) pe = { strike: rec.strike, oi }; }
  }
  return {
    ce, pe,
    atBandEdge: !!((ce && (ce.strike === min || ce.strike === max)) ||
                   (pe && (pe.strike === min || pe.strike === max))),
  };
}

/**
 * Put-Call Ratio by OI across every strike currently held.
 * Band-limited by construction (ATM±N), so it is NOT the chain-wide PCR quoted on
 * NSE and must not be compared against those levels — only against its own trend.
 */
function getPcr() {
  let ceSum = 0, peSum = 0, strikes = 0;
  for (const rec of _strikes.values()) {
    if (!rec.samples.length) continue;
    const oi = rec.samples[rec.samples.length - 1].oi;
    if (rec.side === "CE") ceSum += oi; else peSum += oi;
    strikes++;
  }
  if (!(ceSum > 0)) return { pcr: null, ceOi: ceSum, peOi: peSum, strikes };
  return { pcr: peSum / ceSum, ceOi: ceSum, peOi: peSum, strikes };
}

/**
 * The whole ladder in one object, for the monitor page and (later) a strategy's
 * trade record. `spot` is optional and only used to mark the ATM row.
 *
 * `lookbacks` are in OI MOVES, matching getDeltaOiPct.
 */
function snapshot({ spot = null, lookbacks = [1, 3, 6] } = {}) {
  const atm = spot > 0 ? Math.round(spot / STRIKE_STEP) * STRIKE_STEP : null;
  const byStrike = new Map();

  for (const rec of _strikes.values()) {
    if (!rec.samples.length) continue;
    let row = byStrike.get(rec.strike);
    if (!row) { row = { strike: rec.strike, isAtm: rec.strike === atm, CE: null, PE: null }; byStrike.set(rec.strike, row); }
    const deltas = {};
    for (const lb of lookbacks) {
      const d = getDeltaOiPct(rec.strike, rec.side, lb);
      deltas[lb] = d ? { pct: d.pct, spanMs: d.spanMs } : null;
    }
    row[rec.side] = {
      oi:      rec.samples[rec.samples.length - 1].oi,
      updated: rec.samples[rec.samples.length - 1].ts,
      moves:   rec.samples.length - 1,   // real OI updates observed this session
      deltas,
    };
  }

  return {
    spot,
    atm,
    rows:      [...byStrike.values()].sort((a, b) => a.strike - b.strike),
    walls:     getWalls(),
    pcr:       getPcr(),
    lookbacks,
    lastIngestTs: _lastIngestTs || null,
    strikeCount:  byStrike.size,
  };
}

/** Manual/admin reset. Not called on session start/stop — this is shared market data. */
function reset() {
  _strikes      = new Map();
  _lastIngestTs = 0;
  _day          = null;
}

module.exports = {
  ingest,
  getStrikeOi,
  getDeltaOiPct,
  getWalls,
  getPcr,
  snapshot,
  reset,
  parseOptionSymbol,
  MAX_SAMPLES,
  STRIKE_STEP,
};

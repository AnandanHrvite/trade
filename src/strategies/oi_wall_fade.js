/**
 * OI_WALL_FADE — fade the option wall the writers are still defending
 * ═════════════════════════════════════════════════════════════════════════════
 * Single-leg NIFTY option buying, intraday. Every other engine in this repo is a
 * trend or a breakout engine, so the SIDEWAYS day is the gap they all share. On
 * a range day the levels are not drawn by price — they are set by WHERE THE
 * WRITERS ARE, and per-strike Open Interest is the only input this platform has
 * that says anything about that. Every indicator here (EMA, BB, VWAP,
 * SuperTrend, ATR) is derived from price and therefore adds no new information.
 *
 * ── THE RULE, IN FOUR FACTS ─────────────────────────────────────────────────
 *  1. BAND       The highest-OI CE strike is the resistance wall, the highest-OI
 *                PE strike is the support wall. They must be at least
 *                OIWF_MIN_BAND_PTS apart and the candle must CLOSE inside them.
 *                A band narrower than that cannot pay for the round trip, and no
 *                threshold tuning fixes that.
 *  2. PRESSED    The just-closed candle must have reached within
 *                OIWF_WALL_NEAR_PTS of one of those walls (its HIGH for the CE
 *                wall, its LOW for the PE wall).
 *  3. DEFENDED   That wall's own OI must still be RISING — ΔOI over the last
 *                OIWF_OI_LOOKBACK *OI moves* ≥ OIWF_WALL_BUILD_PCT. Writers are
 *                holding the line. The opposite reading (OI falling by
 *                OIWF_WALL_SHED_PCT or more) is the ANTI-signal: writers are
 *                running, the wall is about to give, stand aside. An UNKNOWN ΔOI
 *                is never treated as zero — it is a refusal.
 *  4. REJECTED   The same candle must CLOSE back away from the wall: red and
 *                below a CE wall, green and above a PE wall. This is what makes
 *                the decision reproducible — it reads a closed bar, not a tick.
 *
 *    Direction  CE wall (resistance) → fade DOWN → BUY_PE
 *               PE wall (support)    → fade UP   → BUY_CE
 *    Target     the MID-BAND level, (ceStrike + peStrike) / 2. A LEVEL, frozen.
 *    Stop       OIWF_SL_BUFFER_PTS beyond the faded wall's strike. Also a LEVEL,
 *               also frozen. Past the wall, the thesis is simply wrong.
 *
 * ── WHY THE WALLS ARE FROZEN AT ENTRY ───────────────────────────────────────
 * The walls move during the day — a new strike can out-rank the old one at any
 * poll. If the target and stop tracked them, a trade opened against the 24800 CE
 * wall could find itself targeting a mid-band 80 points away from the one it was
 * entered on. Both levels are snapshotted into the setup and never move again.
 *
 * ── DELIBERATELY NOT HERE (do not "helpfully" add these) ────────────────────
 * No VIX gate, no futures-OI buildup gate, no ADX, RSI, EMA, VWAP, ATR or
 * SuperTrend, no multi-timeframe bias, no second confirmation candle, no
 * trailing stop, no breakeven jump, no partial booking, no time stop, no premium
 * stop, no re-entry after a stop-out, no expiry-day rule, and NO OI-BASED EXIT —
 * a wall that starts shedding while we are in the trade does NOT exit it. The
 * user chose a price stop, and the price stop is the only stop.
 *
 * ── DETERMINISM, HONESTLY ───────────────────────────────────────────────────
 * The PRICE half of every decision reads a closed NIFTY 50 INDEX candle from the
 * Fyers history endpoint, so it is exactly reproducible. The OI half reads the
 * LIVE in-memory ladder (services/oiChain.js), which /replay does not yet serve:
 * chain_oi.jsonl is recorded, but tickReplay has no timeline for it. A replay of
 * this strategy therefore reproduces the candles and NOT the walls. That is a
 * known hole, stated here rather than hidden, and it is why the OI context of
 * every decision is written onto the trade record and the skip log.
 *
 * ── NOT MARKET-VALIDATED, AND NOT BACKTESTABLE ──────────────────────────────
 * Zero trades, paper or live. There is no backtest and there cannot be one:
 * Fyers exposes no historical per-strike OI, so the only way to research this is
 * to record forward. Every number below is a friction floor or a round number,
 * not a fitted value.
 *
 * Contract:
 *   getConfig()                    -> live env read (never cached)
 *   readBand(oiSnap, cfg)          -> { ce, pe, lo, hi, mid, bandPts, atBandEdge }
 *   wallDelta(oiSnap, strike, side, cfg) -> { pct, spanMs } | null
 *   getSignal(candles, oiSnap, opts) -> { signal, side, entrySpot, slSpot, slPts,
 *                                         targetSpot, wall*, band*, oi*, ... }
 *   targetHit / stopHit            -> the ONLY two exit tests (plus route EOD)
 */

const NAME = "OI_WALL_FADE";
const DESCRIPTION =
  "OI Wall Fade — the highest-OI CE and PE strikes are the day's walls; when price presses one whose OI is still " +
  "rising and the candle closes back away from it, the wall is faded towards the mid-band, stopping just beyond the wall";

// ── primitives ───────────────────────────────────────────────────────────────
function _r2(x) { return Math.round(x * 100) / 100; }

/** IST calendar-day index. India has no DST, so a fixed +5:30 shift is exact. */
function _istDayOf(unixSec) { return Math.floor((unixSec + 19800) / 86400); }

/** IST minutes-of-day from a unix-SECONDS candle time. */
function _utcSecToIstMins(unixSec) { return Math.floor((unixSec + 19800) / 60) % 1440; }

function _istDateStr(unixSec) {
  const d = new Date((unixSec + 19800) * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

/**
 * Parse "HH:MM" → minutes-of-day, falling back to `def` on anything malformed.
 * Deliberately NOT a silent collapse to midnight: a typo in OIWF_ENTRY_END would
 * otherwise close the entry window at 00:00 and the strategy would stand mute
 * all day without a word about why.
 */
function _parseHHMM(raw, def) {
  const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(String(raw == null ? "" : raw));
  if (!m) return def;
  const h = parseInt(m[1], 10), mm = parseInt(m[2], 10);
  if (!Number.isFinite(h) || !Number.isFinite(mm) || h > 23 || mm > 59) return def;
  return h * 60 + mm;
}

function _fmtMins(mins) {
  const h = Math.floor(mins / 60), m = mins % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** Finite-number guard. Number(null)===0 and Number("")===0 both invent a price. */
function _num(x) { return typeof x === "number" && Number.isFinite(x); }

function _numEnv(key, def, min, max) {
  const v = parseFloat(process.env[key]);
  if (!Number.isFinite(v)) return def;
  if (min != null && v < min) return def;
  if (max != null && v > max) return def;
  return v;
}

function _intEnv(key, def, min, max) {
  const v = parseInt(process.env[key], 10);
  if (!Number.isFinite(v)) return def;
  if (min != null && v < min) return def;
  if (max != null && v > max) return def;
  return v;
}

function _boolEnv(key, def) {
  const raw = process.env[key];
  if (raw == null || raw === "") return def;
  return String(raw).trim().toLowerCase() === "true";
}

/** A candle usable for a decision: all four prices finite. */
function _okBar(c) {
  return !!c && _num(c.open) && _num(c.high) && _num(c.low) && _num(c.close);
}

/**
 * Live config read. Settings saves mutate process.env in place, so this must
 * never be cached — every caller re-reads on each evaluation.
 */
function getConfig() {
  return {
    resolutionMins:  _intEnv("OIWF_RESOLUTION", 5, 1, 60),

    // Entries start late on purpose: the ΔOI test needs OIWF_OI_LOOKBACK real OI
    // MOVES to exist, and the first minutes of a session have none.
    entryStartMin:   _parseHHMM(process.env.OIWF_ENTRY_START,  9 * 60 + 45),
    entryEndMin:     _parseHHMM(process.env.OIWF_ENTRY_END,   14 * 60 + 45),

    // The band
    minBandPts:      _numEnv("OIWF_MIN_BAND_PTS", 150, 0),
    wallNearPts:     _numEnv("OIWF_WALL_NEAR_PTS", 30, 0),

    // The OI test. Lookback is in OI MOVES (see oiChain.js), not polls or minutes.
    oiLookback:      _intEnv("OIWF_OI_LOOKBACK", 3, 1, 20),
    wallBuildPct:    _numEnv("OIWF_WALL_BUILD_PCT", 2, 0),
    wallShedPct:     _numEnv("OIWF_WALL_SHED_PCT", 2, 0),
    // A Δ measured in OI MOVES covers a variable amount of wall-clock. Three
    // moves on a quiet afternoon can span hours, and "writers added 2% since
    // 10:00" is not the same claim as "writers are adding right now". 0 = off.
    maxOiSpanSec:    _numEnv("OIWF_MAX_OI_SPAN_SEC", 1800, 0),

    // Risk
    slBufferPts:     _numEnv("OIWF_SL_BUFFER_PTS", 25, 0),

    // Optional guards — both default to OFF, so out of the box the engine does
    // exactly and only what the rules say.
    minTargetPts:    _numEnv("OIWF_MIN_TARGET_PTS", 0, 0),
    requireInnerWall: _boolEnv("OIWF_REQUIRE_INNER_WALL", false),
  };
}

// ── the band ─────────────────────────────────────────────────────────────────
/**
 * Turn an oiChain snapshot into the two walls and the level between them.
 *
 * Returns nulls rather than zeros when the ladder cannot answer — a zero here
 * would be read downstream as a price, and `spot >= 0` is true for every tick.
 *
 * `atBandEdge` is oiChain's own warning that the reported wall sits on the edge
 * of the polled ATM±N window, i.e. the true max-OI strike may be outside it and
 * unseen. It is reported, and only ENFORCED when OIWF_REQUIRE_INNER_WALL is on.
 */
function readBand(oiSnap, cfg) {
  cfg = cfg || getConfig();
  const out = {
    ce: null, pe: null, lo: null, hi: null, mid: null, bandPts: null,
    atBandEdge: null, strikeCount: 0,
  };
  if (!oiSnap || !oiSnap.walls) return out;
  out.strikeCount = _num(oiSnap.strikeCount) ? oiSnap.strikeCount : 0;
  out.atBandEdge  = !!oiSnap.walls.atBandEdge;

  const ce = oiSnap.walls.ce;
  const pe = oiSnap.walls.pe;
  if (!ce || !pe || !_num(ce.strike) || !_num(pe.strike)) return out;

  out.ce = { strike: ce.strike, oi: ce.oi };
  out.pe = { strike: pe.strike, oi: pe.oi };
  out.lo = Math.min(ce.strike, pe.strike);
  out.hi = Math.max(ce.strike, pe.strike);
  out.mid = _r2((out.lo + out.hi) / 2);
  out.bandPts = _r2(out.hi - out.lo);
  return out;
}

/**
 * The ΔOI reading for one wall, or null when the ladder cannot supply one.
 *
 * null means UNKNOWN, never zero. Zero would read as "writers are steady", which
 * is a tradeable claim we would have no evidence for.
 */
function wallDelta(oiSnap, strike, side, cfg) {
  cfg = cfg || getConfig();
  if (!oiSnap || !Array.isArray(oiSnap.rows)) return null;
  const row = oiSnap.rows.find((r) => r && r.strike === strike);
  if (!row) return null;
  const cell = row[side];
  if (!cell || !cell.deltas) return null;
  const d = cell.deltas[cfg.oiLookback];
  if (!d || !_num(d.pct)) return null;
  return { pct: _r2(d.pct), spanMs: _num(d.spanMs) ? d.spanMs : null, oi: cell.oi };
}

// ── the entry signal ─────────────────────────────────────────────────────────
function _baseSignal(cfg) {
  return {
    signal: "NONE", side: null, reason: "", skipReason: "", warmup: false,
    entrySpot: null, slSpot: null, slPts: null, targetSpot: null, targetPts: null,
    rr: null, signalStrength: null,
    // band / wall context — carried onto every trade record and skip log
    wallStrike: null, wallSide: null, wallOi: null, wallDeltaPct: null, wallDeltaSpanSec: null,
    ceWall: null, peWall: null, bandPts: null, bandLo: null, bandHi: null, bandMid: null,
    atBandEdge: null, pcr: null, oiStrikes: 0,
    defend: null, breakAway: null, pressed: null, rejected: null,
    candleTime: null,
    cfg,
  };
}

/**
 * getSignal(candles, oiSnap, opts)
 *
 * @param {Array}  candles ascending NIFTY 50 INDEX bars at cfg.resolutionMins.
 *        The LAST element is the just-CLOSED candle — never a forming bar (the
 *        caller decides that).
 * @param {object} oiSnap  a services/oiChain.js snapshot({ spot }) — the live
 *        ladder. Passed IN rather than required here, so the engine stays pure
 *        and the offline harness can hand it a fixture.
 * @param {object} opts    { cfg, silent, alreadyTraded }
 */
function getSignal(candles, oiSnap, opts) {
  const o = opts || {};
  const cfg = o.cfg || getConfig();
  const base = _baseSignal(cfg);

  // ── The candle ────────────────────────────────────────────────────────────
  if (!Array.isArray(candles) || candles.length < 1) {
    base.warmup = true;
    base.skipReason = base.reason = "Warming up — no closed index candle yet";
    return base;
  }
  const bar = candles[candles.length - 1];
  if (!_okBar(bar)) {
    base.skipReason = base.reason = "Last candle has no usable OHLC — refusing to decide";
    return base;
  }
  base.candleTime = bar.time;

  // Window. The bar's CLOSE time gates it, not its start: the 14:40 bar CLOSES
  // at 14:45, and a start-time check would silently drop the last legal bar.
  const closeMins = _utcSecToIstMins(bar.time) + cfg.resolutionMins;
  if (closeMins <= cfg.entryStartMin) {
    base.skipReason = base.reason =
      `Bar closes ${_fmtMins(closeMins)} — before the ${_fmtMins(cfg.entryStartMin)} entry window opens ` +
      `(the OI ladder needs ${cfg.oiLookback} real OI moves before a Δ means anything)`;
    return base;
  }
  if (closeMins > cfg.entryEndMin) {
    base.skipReason = base.reason = `Past ${_fmtMins(cfg.entryEndMin)} — no new entries`;
    return base;
  }
  if (o.alreadyTraded) {
    base.skipReason = base.reason = "Daily trade budget spent — no new entries";
    return base;
  }

  // ── The band ──────────────────────────────────────────────────────────────
  const band = readBand(oiSnap, cfg);
  base.oiStrikes  = band.strikeCount;
  base.atBandEdge = band.atBandEdge;
  base.pcr = oiSnap && oiSnap.pcr && _num(oiSnap.pcr.pcr) ? _r2(oiSnap.pcr.pcr) : null;

  if (!band.ce || !band.pe) {
    base.warmup = true;
    base.skipReason = base.reason =
      `No OI ladder yet (${band.strikeCount} live strike(s)) — the chain recorder has not produced both a CE and a PE wall`;
    return base;
  }
  base.ceWall  = band.ce;
  base.peWall  = band.pe;
  base.bandPts = band.bandPts;
  base.bandLo  = band.lo;
  base.bandHi  = band.hi;
  base.bandMid = band.mid;

  if (cfg.requireInnerWall && band.atBandEdge) {
    base.skipReason = base.reason =
      `A wall sits on the edge of the polled ATM±N window — the real max-OI strike may be outside it and unseen (OIWF_REQUIRE_INNER_WALL is on)`;
    return base;
  }
  if (!(band.bandPts >= cfg.minBandPts)) {
    base.skipReason = base.reason =
      `Wall band is only ${band.bandPts}pt (${band.lo}–${band.hi}) < ${cfg.minBandPts}pt — too narrow for a fade to pay for the round trip`;
    return base;
  }
  // The CLOSE must sit inside the band, not the high or the low: a candle whose
  // wick pokes THROUGH a wall and comes back is exactly the setup, and testing
  // the extreme would throw it away.
  if (bar.close < band.lo || bar.close > band.hi) {
    base.skipReason = base.reason =
      `Candle closed ${_r2(bar.close)}, outside the wall band ${band.lo}–${band.hi} — there is no range left to fade`;
    return base;
  }

  // ── Which wall is being pressed? ──────────────────────────────────────────
  // Both walls are considered; if the candle somehow reached both (only possible
  // on a band far narrower than the minimum), the NEARER one wins.
  const candidates = [];
  if (bar.high >= band.ce.strike - cfg.wallNearPts) {
    candidates.push({ wall: band.ce, side: "CE", fade: "PE", dist: _r2(Math.abs(band.ce.strike - bar.close)) });
  }
  if (bar.low <= band.pe.strike + cfg.wallNearPts) {
    candidates.push({ wall: band.pe, side: "PE", fade: "CE", dist: _r2(Math.abs(band.pe.strike - bar.close)) });
  }
  base.pressed = candidates.length > 0;
  if (!candidates.length) {
    base.skipReason = base.reason =
      `Candle ${_r2(bar.low)}–${_r2(bar.high)} never came within ${cfg.wallNearPts}pt of either wall (${band.pe.strike} PE / ${band.ce.strike} CE)`;
    return base;
  }
  candidates.sort((a, b) => a.dist - b.dist);
  const pick = candidates[0];
  base.wallStrike = pick.wall.strike;
  base.wallSide   = pick.side;
  base.wallOi     = pick.wall.oi;

  // ── Is that wall still being DEFENDED? ────────────────────────────────────
  const d = wallDelta(oiSnap, pick.wall.strike, pick.side, cfg);
  if (!d) {
    // UNKNOWN is a refusal, not a zero. Without a Δ we cannot tell a wall the
    // writers are defending from one they are abandoning, and those two readings
    // want opposite trades.
    base.skipReason = base.reason =
      `Price pressed the ${pick.side} wall ${pick.wall.strike} but its ΔOI over ${cfg.oiLookback} OI move(s) is UNKNOWN — refusing to fade blind`;
    return base;
  }
  base.wallDeltaPct = d.pct;
  base.wallDeltaSpanSec = d.spanMs != null ? Math.round(d.spanMs / 1000) : null;

  if (cfg.maxOiSpanSec > 0 && base.wallDeltaSpanSec != null && base.wallDeltaSpanSec > cfg.maxOiSpanSec) {
    base.skipReason = base.reason =
      `${pick.side} wall ${pick.wall.strike} ΔOI ${d.pct}% but it took ${base.wallDeltaSpanSec}s to accumulate ` +
      `(> ${cfg.maxOiSpanSec}s) — that is a reading about earlier today, not about now`;
    return base;
  }

  base.breakAway = d.pct <= -cfg.wallShedPct;
  base.defend    = d.pct >= cfg.wallBuildPct;

  if (base.breakAway) {
    base.skipReason = base.reason =
      `DO NOT FADE — price is at the ${pick.side} wall ${pick.wall.strike} and its OI is FALLING ${d.pct}% ` +
      `(≤ -${cfg.wallShedPct}%): the writers are running and the wall is giving way`;
    return base;
  }
  if (!base.defend) {
    base.skipReason = base.reason =
      `${pick.side} wall ${pick.wall.strike} ΔOI is ${d.pct}% over ${cfg.oiLookback} move(s) — neither building (≥${cfg.wallBuildPct}%) ` +
      `nor shedding, so there is no evidence anyone is defending it`;
    return base;
  }

  // ── Did the candle REJECT off the wall? ───────────────────────────────────
  const isCeWall = pick.side === "CE";
  const rejected = isCeWall
    ? bar.close < bar.open && bar.close < pick.wall.strike   // red, and back below resistance
    : bar.close > bar.open && bar.close > pick.wall.strike;  // green, and back above support
  base.rejected = rejected;
  if (!rejected) {
    base.skipReason = base.reason =
      `${pick.side} wall ${pick.wall.strike} is defended (ΔOI +${d.pct}%) but the candle has not rejected off it ` +
      `(open ${_r2(bar.open)} → close ${_r2(bar.close)}) — waiting for a close back ${isCeWall ? "below" : "above"} the wall`;
    return base;
  }

  // ── Levels. Both are LEVELS, both frozen; neither ever moves again. ───────
  const entry  = _r2(bar.close);
  const target = band.mid;
  const slSpot = _r2(isCeWall ? pick.wall.strike + cfg.slBufferPts : pick.wall.strike - cfg.slBufferPts);
  const side   = pick.fade;

  // Geometry sanity. Every level is checked finite BEFORE it is compared:
  // `spot >= null` is `spot >= 0`, which is true on the very first tick.
  if (!_num(target) || !_num(slSpot)) {
    base.skipReason = base.reason = "Target or stop level not computable — refusing to enter without both";
    return base;
  }
  if (side === "CE" ? entry >= target : entry <= target) {
    base.skipReason = base.reason =
      `Candle closed ${entry}, already ${side === "CE" ? "at or above" : "at or below"} the mid-band target ${target} — nothing left to trade`;
    return base;
  }
  if (side === "CE" ? entry <= slSpot : entry >= slSpot) {
    base.skipReason = base.reason =
      `Candle closed ${entry}, already ${side === "CE" ? "at or below" : "at or above"} the stop ${slSpot} — the trade would be stopped on its first tick`;
    return base;
  }

  const slPts     = _r2(Math.abs(slSpot - entry));
  const targetPts = _r2(Math.abs(target - entry));
  const rr        = slPts > 0 ? _r2(targetPts / slPts) : null;
  base.slPts = slPts;
  base.targetPts = targetPts;
  base.rr = rr;

  if (!(slPts > 0)) {
    base.skipReason = base.reason = `Stop distance resolved to ${slPts}pt — refusing a zero-risk trade`;
    return base;
  }
  if (cfg.minTargetPts > 0 && targetPts < cfg.minTargetPts) {
    base.skipReason = base.reason =
      `Setup valid but the mid-band is only ${targetPts}pt away < ${cfg.minTargetPts}pt — SKIPPED`;
    return base;
  }

  base.signal = side === "CE" ? "BUY_CE" : "BUY_PE";
  base.side   = side;
  base.signalStrength = "STRONG";
  base.entrySpot  = entry;
  base.slSpot     = slSpot;
  base.targetSpot = target;
  base.reason =
    `OI WALL FADE ${side}: the ${pick.side} wall at ${pick.wall.strike} (OI ${pick.wall.oi}) is DEFENDED — ΔOI +${d.pct}% over ` +
    `${cfg.oiLookback} move(s)${base.wallDeltaSpanSec != null ? ` in ${base.wallDeltaSpanSec}s` : ""}, and the candle rejected off it ` +
    `(${_r2(bar.high)}/${_r2(bar.low)} → close ${entry}) | band ${band.lo}–${band.hi} (${band.bandPts}pt)` +
    `${band.atBandEdge ? " ⚠ a wall sits at the polled-band edge" : ""} | target = mid-band ${target} (${targetPts}pt) | ` +
    `SL = ${cfg.slBufferPts}pt beyond the wall at ${slSpot} (${slPts}pt) | R:R ${rr}`;

  if (!o.silent) {
    const ist = new Date(bar.time * 1000).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: false });
    console.log(`[OI_WALL_FADE ${ist}] ENTER ${side} @ ${entry} | TGT ${target} (${targetPts}pt) | SL ${slSpot} (${slPts}pt) | R:R ${rr}`);
  }
  return base;
}

// ── Exit rules (ONE place, so paper / live / replay cannot drift) ────────────
/**
 * Mid-band reached? The target is a fixed LEVEL. A CE (faded the PE support
 * wall) wants price UP to the mid-band; a PE wants price DOWN to it.
 *
 * `target` must be a finite level — `price <= null` is `price <= 0`, which would
 * book a target on the very first tick.
 */
function targetHit(side, price, target) {
  if (!_num(price) || !_num(target)) return false;
  return side === "CE" ? price >= target : price <= target;
}

/**
 * Wall taken out? The stop is a fixed LEVEL and never moves. A PE (faded the CE
 * resistance wall) is stopped when price pushes UP through the wall; a CE when
 * price breaks DOWN through the support wall.
 */
function stopHit(side, price, stop) {
  if (!_num(price) || !_num(stop)) return false;
  return side === "CE" ? price <= stop : price >= stop;
}

module.exports = {
  NAME,
  DESCRIPTION,
  getConfig,
  readBand,
  wallDelta,
  getSignal,
  targetHit,
  stopHit,
  // shared time helpers (routes must not re-derive IST arithmetic)
  _istDayOf,
  _istDateStr,
  _utcSecToIstMins,
  _parseHHMM,
  _fmtMins,
};

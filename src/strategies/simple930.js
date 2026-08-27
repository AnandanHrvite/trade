/**
 * SIMPLE_9:30 — buy the opening leg that clears ₹180 on its OWN premium chart
 * ═════════════════════════════════════════════════════════════════════════════
 * Single-leg NIFTY option buying, intraday, at most ONE trade a day. Every
 * decision this engine makes is read off an OPTION PREMIUM. The NIFTY index is
 * read for exactly one thing — the ATM strike the candidate list is built around
 * — and for nothing else. There is no spot-chart rule anywhere in this file.
 *
 * ── THE DAY, IN FOUR EVENTS ─────────────────────────────────────────────────
 *
 *  1. 09:25 SELECTION.  Take the NIFTY spot, round it to the ATM strike, and
 *     quote the ITM ladder on both sides:
 *         CE candidates  atm, atm-50, atm-100, …   (a CALL is ITM below spot)
 *         PE candidates  atm, atm+50, atm+100, …   (a PUT  is ITM above spot)
 *     On each side keep the ONE strike whose premium is closest to ₹180
 *     (SIMPLE930_TRIGGER_PREMIUM). That is the watchlist: exactly 1 CE + 1 PE.
 *     Selection happens ONCE per day and never moves — a watchlist that drifts
 *     with spot is not reproducible, and Replay could never re-derive it.
 *
 *  2. ENTRY.  From 09:25 to 09:35 (SIMPLE930_ENTRY_START → _ENTRY_END), watch
 *     both watchlist premiums. The FIRST one to trade above ₹180 is bought at
 *     market, immediately. It may be the CE or the PE — whichever gets there
 *     first. If neither clears ₹180 by 09:35 there is no trade today.
 *     "Above" means strictly greater than the trigger: at exactly ₹180 nothing
 *     has broken yet.
 *
 *  3. STOP + TRAIL.  The stop is a DISTANCE of 20 points from the ACTUAL FILL,
 *     not a fixed price level: filled at 181 → stop 161.
 *
 *     The trail does NOT start there. It stays DISARMED — the flat 20-point
 *     stop is the only risk — until the premium has actually touched the top
 *     of the box (₹215 at the defaults, `bandUp`). Only then does it begin
 *     trailing the highest premium seen by 20 points, ratcheting UP only —
 *     220 → 200, 240 → 220 — never moving down and never falling below the
 *     initial stop.
 *
 *     Why arm it late: a trail that is live from the first tick converts the
 *     20-point stop into a much tighter one the moment the premium ticks up a
 *     rupee or two. A fill at 185.05 that peaked at 191.85 — noise, six points,
 *     nowhere near the box top — trailed its stop up to 171.85 and was closed
 *     for a loss while the real 165.05 stop had never been touched. The trade
 *     was stopped out by its own trail on a move that meant nothing. Arming at
 *     the box top means the trail only ever protects a move the rule itself
 *     calls significant, which is the same ₹215 line the 09:45 box already uses.
 *
 *  4. 09:45 SIDEWAYS EXIT.  If the trade is still open at 09:45 and the premium
 *     has spent those minutes oscillating — never trading at/above ₹220 and
 *     never at/below ₹160 — it is closed at market, profit or loss. A trade
 *     that DID expand past either edge is left alone; the trail now owns it,
 *     all the way to the 15:15 square-off if need be.
 *
 * ── WHY THE BAND IS EXPRESSED AS OFFSETS ────────────────────────────────────
 * The rule quotes ₹220 and ₹160 against a ₹180 trigger. Those are stored as
 * offsets (+40 / −20) rather than absolutes so that changing the trigger moves
 * the whole geometry together instead of silently leaving a band around a level
 * nothing trades near. At the defaults they resolve to exactly 220 and 160.
 *
 * Honest note about the lower edge: with a 20-point stop the trade is already
 * out at fill−20 before the premium can reach trigger−20, so the DOWN edge of
 * the band is unreachable in practice while the stop is armed. It is
 * implemented anyway because it is in the rule, and it becomes live the moment
 * SIMPLE930_SL_PTS is widened past the band offset.
 *
 * ── DETERMINISM ─────────────────────────────────────────────────────────────
 * Every input is an option premium fetched through fyers.getQuotes and recorded
 * to the tick archive by the caller. Replay serves those same recorded quotes
 * back at the replay clock, so Paper, Live-harness and Replay compute identical
 * numbers. Nothing here reads a live spot except calcATMStrike's input, which
 * is sampled ONCE at 09:25 and then frozen into the day's plan.
 *
 * ── DELIBERATELY NOT HERE (do not "helpfully" add these) ────────────────────
 * No VIX gate, no OI filter, no ADX/RSI/EMA/VWAP/ATR/SuperTrend, no spot-chart
 * confirmation, no multi-timeframe bias, no confirmation candle, no breakeven
 * jump, no partial booking, no re-entry after the day's trade, no expiry-day
 * rule, no delta/theta model, no ITM-steps setting (the ₹180 premium IS the
 * strike rule — an ITM-steps key would be a second, contradictory selector).
 *
 * Three guards default to 0 = OFF so the shipped behaviour is exactly the rule:
 *   SIMPLE930_MAX_PREMIUM_DIST — refuse a side whose best candidate is nowhere
 *                                near ₹180 (see selectWatchlist).
 *   SIMPLE930_MIN_PREMIUM      — refuse a candidate cheaper than this.
 *   SIMPLE930_SUSTAIN_POLLS    — 1 = enter on the first quote above the
 *                                trigger, which is what "take entry
 *                                immediately" says. >1 demands N consecutive
 *                                quotes above it before entering.
 *
 * ── NOT MARKET-VALIDATED ────────────────────────────────────────────────────
 * Zero trades, paper or live. Nothing in this file has been fitted to data; the
 * numbers are the operator's own rule. Collect clean paper sessions and diff
 * them against /replay before any live gate is touched.
 *
 * Contract:
 *   getConfig()                              -> live env read (never cached)
 *   buildCandidateStrikes(atm, cfg)          -> the ladder quoted at 09:25
 *   selectWatchlist(quotes, atm, cfg)        -> { ce, pe, candidates, notes }
 *   bandLevels(cfg)                          -> { up, down }
 *   evaluateTrigger(legs, cfg, sustain)      -> { fire, leg, ltp, reason, … }
 *   computeInitialStop(fillLtp, cfg)         -> stop as a DISTANCE off the fill,
 *                                             or null when it would land at/below
 *                                             zero (the caller must then refuse)
 *   computeTrailStop(peak, initialStop, cfg, pos) -> ratcheting trail (armed at bandUp)
 *   isTrailArmed(peak, cfg, pos)             -> has the peak reached the box top?
 *   isExpanded(peak, trough, cfg, pos?)      -> did it leave the 160–220 box?
 *                                             (an open position keeps its own box)
 *   exitCheck(pos, ltp, nowMin, cfg)         -> the ONLY exit decision
 */

const NAME = "SIMPLE_9:30";
const DESCRIPTION =
  "SIMPLE_9:30 — at 09:25 the ITM strike trading nearest ₹180 is picked on each side; the first of the two to " +
  "clear ₹180 by 09:35 is bought with a 20-point stop that only starts trailing once the premium touches the " +
  "top of the 160–220 box, and a trade still boxed inside that range at 09:45 is closed";

// The NSE NIFTY option ladder is struck every 50 points. Not configurable:
// a different step would build symbols that do not exist.
const STRIKE_STEP = 50;

// ── primitives ───────────────────────────────────────────────────────────────
function _r2(x) { return Math.round(x * 100) / 100; }

/** IST calendar-day index. India has no DST, so a fixed +5:30 shift is exact. */
function _istDayOf(unixSec) { return Math.floor((unixSec + 19800) / 86400); }

/** IST minutes-of-day from a unix-SECONDS timestamp. */
function _utcSecToIstMins(unixSec) { return Math.floor((unixSec + 19800) / 60) % 1440; }

/** IST minutes-of-day from a unix-MILLISECONDS timestamp. */
function _msToIstMins(unixMs) { return Math.floor((unixMs + 19800000) / 60000) % 1440; }

function _istDateStr(unixSec) {
  const d = new Date((unixSec + 19800) * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

/**
 * Parse "HH:MM" → minutes-of-day, falling back to `def` on anything malformed.
 * Deliberately NOT a silent collapse to midnight: a typo in SIMPLE930_ENTRY_END
 * would otherwise close the entry window at 00:00 and the strategy would stand
 * mute all day without a word about why.
 */
function _parseHHMM(raw, def) {
  const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(String(raw == null ? "" : raw));
  if (!m) return def;
  const h = parseInt(m[1], 10), mm = parseInt(m[2], 10);
  if (!Number.isFinite(h) || !Number.isFinite(mm) || h > 23 || mm > 59) return def;
  return h * 60 + mm;
}

function _fmtMins(mins) {
  if (!Number.isFinite(mins)) return "—";
  const h = Math.floor(mins / 60), m = ((mins % 60) + 60) % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** Finite-number guard. Number(null)===0 and Number("")===0 both invent a price. */
function _num(x) { return typeof x === "number" && Number.isFinite(x); }

/** A usable premium: finite AND positive. A ₹0 quote is a dead contract, not a price. */
function _px(x) { return _num(x) && x > 0; }

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

/**
 * Live config read. Settings saves mutate process.env in place, so this must
 * never be cached — every caller re-reads on each evaluation.
 */
function getConfig() {
  const trigger = _numEnv("SIMPLE930_TRIGGER_PREMIUM", 180, 1, 5000);
  return {
    // ── The clock (IST) ──
    // Selection is a single instant, not a window: the chain is quoted once.
    selectionMin:   _parseHHMM(process.env.SIMPLE930_SELECTION_TIME, 9 * 60 + 25),
    // Entries are allowed from the moment the watchlist exists — the operator's
    // rule is "if it is above 180, take it", not "wait for 09:30".
    entryStartMin:  _parseHHMM(process.env.SIMPLE930_ENTRY_START,    9 * 60 + 25),
    entryEndMin:    _parseHHMM(process.env.SIMPLE930_ENTRY_END,      9 * 60 + 35),
    sidewaysMin:    _parseHHMM(process.env.SIMPLE930_SIDEWAYS_CHECK, 9 * 60 + 45),
    forcedExitMin:  _parseHHMM(process.env.SIMPLE930_FORCED_EXIT,   15 * 60 + 15),

    // ── The premium geometry ──
    // ONE number drives both the strike search and the breakout level, because
    // in the rule they are the same ₹180. Two keys could silently disagree.
    triggerPremium: trigger,
    bandUp:         _r2(trigger + _numEnv("SIMPLE930_BAND_UP_OFFSET",   40, 0, 2000)),
    // Clamped at 0: a premium cannot trade below zero, so a negative floor is
    // not a level, it is a number that can never be touched — and it printed as
    // "₹-10" in the exit reason.
    bandDown:       _r2(Math.max(0, trigger - _numEnv("SIMPLE930_BAND_DOWN_OFFSET", 20, 0, 2000))),

    // ── The ladder quoted at 09:25 ──
    // ITM depth per side. 8 × 50 = 400 points, which covers a ₹180 premium from
    // a fresh weekly (barely ITM) to expiry day (almost all intrinsic).
    scanItmStrikes: _intEnv("SIMPLE930_SCAN_ITM_STRIKES", 8, 1, 20),
    // OTM depth. 0 = the rule as written (ATM + ITM only). Raise it when the
    // whole ITM ladder sits far ABOVE ₹180 — that happens on a fresh weekly
    // where even the ATM contract is dearer than the trigger.
    scanOtmStrikes: _intEnv("SIMPLE930_SCAN_OTM_STRIKES", 0, 0, 20),

    // ── Risk ──
    slPts:          _numEnv("SIMPLE930_SL_PTS",    20, 0.5, 500),
    trailPts:       _numEnv("SIMPLE930_TRAIL_PTS", 20, 0.5, 500),
    trailEnabled:   _boolEnv("SIMPLE930_TRAIL_ENABLED", true),
    // The trail is DISARMED until the premium has touched the top of the box.
    // Without this the trail tightens the 20-point stop on the first rupee of
    // noise — see the header. Turn it off to get the old arm-on-entry trail
    // back; the arming level itself is always `bandUp`, never a separate key,
    // so it cannot silently disagree with the box the 09:45 exit reads.
    trailArmAtBandUp: _boolEnv("SIMPLE930_TRAIL_ARM_AT_BAND_UP", true),

    // ── Guards that default to OFF (see the header) ──
    maxPremiumDist: _numEnv("SIMPLE930_MAX_PREMIUM_DIST", 0, 0, 5000),
    minPremium:     _numEnv("SIMPLE930_MIN_PREMIUM",      0, 0, 5000),
    sustainPolls:   _intEnv("SIMPLE930_SUSTAIN_POLLS",    1, 1, 60),
  };
}

// ── The 09:25 ladder ─────────────────────────────────────────────────────────
/**
 * The strikes quoted at selection time, both sides, nearest-the-money first.
 *
 * Moneyness is measured against the ATM STRIKE, not the raw spot: ATM is
 * already a rounded, reproducible number, and anchoring to it means the ladder
 * is identical whether spot is 24 337 or 24 362. A CALL is in the money below
 * spot and a PUT above it, so the two ladders walk in opposite directions.
 *
 * @param {number} atm  ATM strike (a multiple of 50)
 * @param {object} cfg  getConfig()
 * @returns {Array<{strike:number, side:"CE"|"PE", steps:number, moneyness:string}>}
 *          `steps` is signed: negative = ITM, 0 = ATM, positive = OTM.
 */
function buildCandidateStrikes(atm, cfg) {
  cfg = cfg || getConfig();
  const out = [];
  if (!_num(atm) || atm <= 0) return out;
  for (const side of ["CE", "PE"]) {
    // CE goes ITM by stepping DOWN, PE by stepping UP.
    const itmDir = side === "CE" ? -1 : 1;
    for (let k = -cfg.scanOtmStrikes; k <= cfg.scanItmStrikes; k++) {
      // k < 0 → OTM, k = 0 → ATM, k > 0 → ITM
      const strike = atm + itmDir * k * STRIKE_STEP;
      if (strike <= 0) continue;
      out.push({
        strike,
        side,
        steps: -k,
        moneyness: k > 0 ? "ITM" : k === 0 ? "ATM" : "OTM",
      });
    }
  }
  return out;
}

/** Full Fyers option symbol for one ladder rung. */
function optionSymbol(expiryCode, strike, side) {
  return `NSE:NIFTY${expiryCode}${strike}${side}`;
}

// ── The 09:25 selection ──────────────────────────────────────────────────────
/**
 * Pick the ONE strike per side whose premium sits closest to the trigger.
 *
 * `quotes` is whatever the caller managed to fetch — an array of
 * { strike, side, ltp, symbol? }. Rungs that came back without a usable premium
 * are reported in `notes.missing` rather than silently dropped: a half-quoted
 * ladder that still produces a pick is a materially weaker selection, and the
 * operator has to be able to see that it happened.
 *
 * Ordering is total and deterministic, which matters because Replay must
 * reproduce the same pick from the same recording:
 *    1. smaller |premium − trigger| wins
 *    2. tie → the strike nearer the money wins (cheaper, more leverage)
 *    3. still tied → the LOWER strike wins
 *
 * @returns {{ ce:object|null, pe:object|null, candidates:Array, notes:object }}
 *          each pick is { strike, side, ltp, dist, steps, moneyness, symbol }.
 */
function selectWatchlist(quotes, atm, cfg) {
  cfg = cfg || getConfig();
  const notes = { missing: [], rejected: [], atm, trigger: cfg.triggerPremium };
  const out = { ce: null, pe: null, candidates: [], notes };
  if (!Array.isArray(quotes) || !quotes.length) {
    notes.reason = "no option quotes were returned for the 09:25 ladder";
    return out;
  }

  const scored = [];
  for (const q of quotes) {
    if (!q || (q.side !== "CE" && q.side !== "PE") || !_num(q.strike)) continue;
    if (!_px(q.ltp)) { notes.missing.push({ strike: q.strike, side: q.side, symbol: q.symbol || null }); continue; }
    if (cfg.minPremium > 0 && q.ltp < cfg.minPremium) {
      notes.rejected.push({ strike: q.strike, side: q.side, ltp: _r2(q.ltp), why: `below SIMPLE930_MIN_PREMIUM ₹${cfg.minPremium}` });
      continue;
    }
    scored.push({
      strike:    q.strike,
      side:      q.side,
      symbol:    q.symbol || null,
      ltp:       _r2(q.ltp),
      dist:      _r2(Math.abs(q.ltp - cfg.triggerPremium)),
      steps:     _num(q.steps) ? q.steps : null,
      moneyness: q.moneyness || null,
    });
  }
  // One stable ordering for the whole list, so the UI table and the pick agree.
  scored.sort((a, b) =>
    a.dist - b.dist ||
    Math.abs(a.strike - atm) - Math.abs(b.strike - atm) ||
    a.strike - b.strike);
  out.candidates = scored;

  for (const side of ["CE", "PE"]) {
    const best = scored.find(c => c.side === side) || null;
    if (!best) {
      notes.rejected.push({ side, why: "no usable premium on this side" });
      continue;
    }
    if (cfg.maxPremiumDist > 0 && best.dist > cfg.maxPremiumDist) {
      notes.rejected.push({
        side, strike: best.strike, ltp: best.ltp,
        why: `nearest premium ₹${best.ltp} is ${best.dist} away from ₹${cfg.triggerPremium} (> SIMPLE930_MAX_PREMIUM_DIST ${cfg.maxPremiumDist})`,
      });
      continue;
    }
    out[side === "CE" ? "ce" : "pe"] = best;
  }
  return out;
}

// ── The band ─────────────────────────────────────────────────────────────────
/** Absolute rupee edges of the 09:45 sideways box. */
function bandLevels(cfg) {
  cfg = cfg || getConfig();
  return { up: cfg.bandUp, down: cfg.bandDown };
}

// ── The entry trigger ────────────────────────────────────────────────────────
/**
 * Has either watchlist leg cleared the trigger?
 *
 * `legs` is { ce, pe }, each either null or { symbol, strike, ltp, ... }.
 * `sustain` is { CE:n, PE:n } — how many CONSECUTIVE prior observations that
 * leg has already been above the trigger. The caller owns that counter because
 * only it knows what "consecutive" means for its poll cadence; at the default
 * SIMPLE930_SUSTAIN_POLLS = 1 it is not read at all.
 *
 * Strictly greater than the trigger: at exactly ₹180 nothing has broken yet.
 * When BOTH legs are above on the same observation the higher premium wins —
 * it is the one that has travelled further past the level, and an arbitrary
 * CE-always-first rule would bias every such day to calls.
 *
 * @returns {{fire:boolean, leg:string|null, ltp:number|null, reason:string, both:boolean}}
 */
function evaluateTrigger(legs, cfg, sustain) {
  cfg = cfg || getConfig();
  const s = sustain || {};
  const l = legs || {};
  const above = [];
  for (const side of ["CE", "PE"]) {
    const leg = side === "CE" ? l.ce : l.pe;
    if (!leg) continue;
    if (!_px(leg.ltp)) continue;
    if (leg.ltp > cfg.triggerPremium) above.push({ side, leg });
  }
  if (!above.length) {
    const ceTxt = l.ce && _px(l.ce.ltp) ? `CE ₹${_r2(l.ce.ltp)}` : "CE —";
    const peTxt = l.pe && _px(l.pe.ltp) ? `PE ₹${_r2(l.pe.ltp)}` : "PE —";
    return { fire: false, leg: null, ltp: null, both: false, reason: `neither leg above ₹${cfg.triggerPremium} (${ceTxt} · ${peTxt})` };
  }
  above.sort((a, b) => b.leg.ltp - a.leg.ltp);
  const pick = above[0];
  const seen = (Number(s[pick.side]) || 0) + 1;
  if (cfg.sustainPolls > 1 && seen < cfg.sustainPolls) {
    return {
      fire: false, leg: pick.side, ltp: _r2(pick.leg.ltp), both: above.length > 1,
      reason: `${pick.side} ₹${_r2(pick.leg.ltp)} is above ₹${cfg.triggerPremium} but has only held for ${seen}/${cfg.sustainPolls} quote(s)`,
    };
  }
  return {
    fire: true,
    leg: pick.side,
    ltp: _r2(pick.leg.ltp),
    both: above.length > 1,
    reason: `${pick.side} ${pick.leg.strike} broke ₹${cfg.triggerPremium} — premium ₹${_r2(pick.leg.ltp)}` +
      (above.length > 1 ? ` (both legs were above; took the one further through the level)` : ""),
  };
}

// ── Stop + trail ─────────────────────────────────────────────────────────────
/**
 * The initial stop, as a DISTANCE below the ACTUAL FILL — not a fixed level.
 * Filled at 181 → 161. Filled at 186 → 166. Anchoring it to the trigger instead
 * would hand a slipped fill a wider stop than the rule allows.
 * Never returns a negative price: a premium cannot go below zero.
 */
function computeInitialStop(fillLtp, cfg) {
  cfg = cfg || getConfig();
  if (!_px(fillLtp)) return null;
  const stop = _r2(fillLtp - cfg.slPts);
  // A stop at or below zero is NOT a stop: `ltp <= 0` can never be true for a
  // live premium, so the position would ride with its risk switched off and only
  // the EOD square-off could close it. Returning null makes the caller refuse the
  // trade — "refuse rather than enter without one". Reachable whenever
  // SIMPLE930_SL_PTS is set at or above SIMPLE930_TRIGGER_PREMIUM.
  if (stop <= 0) return null;
  return stop;
}

/**
 * Is the trail allowed to move yet?
 *
 * With `trailArmAtBandUp` on (the default) the trail stays disarmed until the
 * premium has traded at or above the top of the box — the same `bandUp` level
 * the 09:45 sideways exit reads, and taken from the POSITION when one is passed
 * so a mid-trade Settings change cannot re-arm or dis-arm a running trade.
 * Touching the level counts, exactly as it does in `isExpanded`.
 */
function describeTrail(cfg, pos) {
  cfg = cfg || getConfig();
  if (!cfg.trailEnabled) return "no trail";
  const up = pos && _num(pos.bandUp) ? pos.bandUp : cfg.bandUp;
  const armMode = pos && typeof pos.trailArmAtBandUp === "boolean"
    ? pos.trailArmAtBandUp : cfg.trailArmAtBandUp;
  if (!armMode || !_num(up)) return `trailing ${cfg.trailPts}pt from entry`;
  return `trailing ${cfg.trailPts}pt, armed only once the premium touches ₹${up}`;
}

function isTrailArmed(peakLtp, cfg, pos) {
  cfg = cfg || getConfig();
  // The position's own setting wins while it is running — same reason isExpanded
  // reads the frozen band: flipping this mid-trade would hand a live trade a
  // different stop than the one it was opened under.
  const armMode = pos && typeof pos.trailArmAtBandUp === "boolean"
    ? pos.trailArmAtBandUp : cfg.trailArmAtBandUp;
  if (!armMode) return true;
  const up = pos && _num(pos.bandUp) ? pos.bandUp : cfg.bandUp;
  if (!_num(up)) return true;
  return _px(peakLtp) && peakLtp >= up;
}

/**
 * The trailing stop: `trailPts` under the highest premium seen since entry,
 * ratcheting UP only and never below the initial stop.
 *
 * Returns the initial stop unchanged when the trail is off, when the trail has
 * not ARMED yet (the peak has not reached the top of the box), when the peak is
 * unusable, or whenever the trail has not yet climbed past it — so the caller
 * can assign the result unconditionally.
 */
function computeTrailStop(peakLtp, initialStop, cfg, pos) {
  cfg = cfg || getConfig();
  const floor = _num(initialStop) ? initialStop : null;
  if (!cfg.trailEnabled || !_px(peakLtp)) return floor;
  if (!isTrailArmed(peakLtp, cfg, pos)) return floor;
  const trail = _r2(Math.max(0, peakLtp - cfg.trailPts));
  if (floor == null) return trail;
  return trail > floor ? trail : floor;
}

// ── The 09:45 box ────────────────────────────────────────────────────────────
/**
 * Did the premium leave the 160–220 box at any point since entry?
 * Touching an edge counts as leaving it — the rule says "not going ABOVE 220 or
 * BELOW 160", and a trade that printed exactly 220 has done what was asked.
 */
function isExpanded(peak, trough, cfg, pos) {
  cfg = cfg || getConfig();
  // A live position carries the box it was OPENED under. Config is read live —
  // that is what makes a Settings save apply without a restart — but re-pricing
  // a trade that is already running is a different thing: widening the box at
  // 09:40 would RE-ARM the 09:45 exit on a trade that had already left it and
  // close a winner the rule had released. Frozen levels win while a trade is on;
  // the live config governs the next one.
  const up   = pos && _num(pos.bandUp)   ? pos.bandUp   : cfg.bandUp;
  const down = pos && _num(pos.bandDown) ? pos.bandDown : cfg.bandDown;
  if (_px(peak) && peak >= up) return true;
  if (_px(trough) && trough <= down) return true;
  return false;
}

// ── Exits ────────────────────────────────────────────────────────────────────
/**
 * The ONLY exit decision in this strategy. Tested in this order on every quote:
 *
 *   1. STOP / TRAIL  — premium at or below the current stop.
 *   2. SIDEWAYS      — 09:45 reached, still boxed inside the band.
 *   3. EOD           — 15:15 square-off.
 *
 * The stop is tested first on purpose: when a single quote is the first
 * evidence of both a stop-out and the 09:45 deadline, the stop is the earlier
 * event in any plausible path between samples, and booking the worse of two
 * possible fills is the only honest reading.
 *
 * `pos` needs { stop, peak, trough, side, symbol, entryMin }. `entryMin` is the
 * IST minute-of-day the position opened; it is optional, and when absent the
 * 09:45 rule behaves exactly as it did before. Every level is checked with
 * Number.isFinite before it is compared — `ltp <= null` is `ltp <= 0`, which
 * would square the trade off on its very first quote.
 *
 * @param {number} nowMin IST minutes-of-day of the observation
 * @returns {{exit:boolean, kind:string, reason:string}|{exit:false}}
 */
function exitCheck(pos, ltp, nowMin, cfg) {
  cfg = cfg || getConfig();
  if (!pos) return { exit: false };
  if (!_px(ltp)) return { exit: false };

  if (_num(pos.stop) && ltp <= pos.stop) {
    const trailed = _num(pos.initialStop) && pos.stop > pos.initialStop;
    return {
      exit: true,
      kind: trailed ? "TRAIL" : "STOP",
      reason: trailed
        ? `Trailing stop hit — premium ₹${_r2(ltp)} fell to the trail at ₹${_r2(pos.stop)} (peak was ₹${_r2(pos.peak)}, ${cfg.trailPts}pt behind it)`
        : `Stop hit — premium ₹${_r2(ltp)} fell to the ${cfg.slPts}pt stop at ₹${_r2(pos.stop)}`,
    };
  }

  // The box is a wall-clock rule about a trade that has RUN INTO the check.
  // A position opened at or after the check time was never given those minutes,
  // and without this guard it would be closed on its very first quote — which
  // is what happens the moment an operator sets ENTRY_END past SIDEWAYS_CHECK.
  // Out of the box the windows cannot overlap (09:35 vs 09:45); both are
  // settable, so the guard is real rather than theoretical.
  const _openedBeforeCheck = !_num(pos.entryMin) || pos.entryMin < cfg.sidewaysMin;
  if (_num(nowMin) && nowMin >= cfg.sidewaysMin && _openedBeforeCheck && !isExpanded(pos.peak, pos.trough, cfg, pos)) {
    const _up   = _num(pos.bandUp)   ? pos.bandUp   : cfg.bandUp;
    const _down = _num(pos.bandDown) ? pos.bandDown : cfg.bandDown;
    return {
      exit: true,
      kind: "SIDEWAYS",
      reason: `Sideways exit at ${_fmtMins(cfg.sidewaysMin)} — premium never left ₹${_down}–₹${_up} ` +
              `(ranged ₹${_r2(pos.trough)}–₹${_r2(pos.peak)}), closing at ₹${_r2(ltp)} whatever the P&L`,
    };
  }

  if (_num(nowMin) && nowMin >= cfg.forcedExitMin) {
    return {
      exit: true,
      kind: "EOD",
      reason: `EOD square-off (${_fmtMins(cfg.forcedExitMin)} IST) — premium ₹${_r2(ltp)}`,
    };
  }

  return { exit: false };
}

/** Is `nowMin` inside the entry window? Both edges inclusive of the start. */
function inEntryWindow(nowMin, cfg) {
  cfg = cfg || getConfig();
  return _num(nowMin) && nowMin >= cfg.entryStartMin && nowMin <= cfg.entryEndMin;
}

/**
 * One-line human summary of the day's plan, for the session log, the Telegram
 * start alert and the strategy guide. Built here so all three cannot drift.
 */
function describePlan(cfg) {
  cfg = cfg || getConfig();
  return `select @ ${_fmtMins(cfg.selectionMin)} the strike nearest ₹${cfg.triggerPremium} per side · ` +
         `enter the first leg above ₹${cfg.triggerPremium} between ${_fmtMins(cfg.entryStartMin)} and ${_fmtMins(cfg.entryEndMin)} · ` +
         `SL ${cfg.slPts}pt off the fill, ${describeTrail(cfg)} · ` +
         `exit at ${_fmtMins(cfg.sidewaysMin)} if still inside ₹${cfg.bandDown}–₹${cfg.bandUp} · ` +
         `EOD ${_fmtMins(cfg.forcedExitMin)}`;
}

module.exports = {
  NAME,
  DESCRIPTION,
  STRIKE_STEP,
  getConfig,
  buildCandidateStrikes,
  optionSymbol,
  selectWatchlist,
  bandLevels,
  evaluateTrigger,
  computeInitialStop,
  computeTrailStop,
  isTrailArmed,
  describeTrail,
  isExpanded,
  exitCheck,
  inEntryWindow,
  describePlan,
  // shared helpers — routes must not re-derive IST arithmetic or number guards
  _istDayOf,
  _istDateStr,
  _utcSecToIstMins,
  _msToIstMins,
  _parseHHMM,
  _fmtMins,
  _num,
  _px,
  _r2,
};

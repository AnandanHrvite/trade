// Shared paper-trade guards: bid-ask spread filter at entry, the global
// profit lock (the only automatic exit in every strategy) and the re-entry
// cooldown after an exit. Keeps paper and backtest engines aligned.

const tickRecorder = require("./tickRecorder");

// Read thresholds LIVE from process.env on each call — not frozen at require()
// time. Previously these were module-load constants, so a Settings edit only
// took effect after a full process restart (the Settings UI wrongly labelled it
// "session restart"). Live reads make the toggle apply on the next entry check.
// Numeric env parse with a default for blank/garbled values. A NaN threshold
// makes every `<`/`>=` comparison false, so a guard silently failed OPEN.
function _numOr(raw, def) {
  const n = typeof raw === "number" ? raw : parseFloat(raw);
  return Number.isFinite(n) ? n : def;
}
function liveMaxSpreadPts()      { return _numOr(parseFloat(process.env.MAX_BID_ASK_SPREAD_PTS || "2"), 2); }
// Common Trade Rules on/off (Settings). Unset = on, so old .env files keep today's behaviour.
function liveSpreadCheckEnabled() { return String(process.env.MAX_BID_ASK_SPREAD_ENABLED ?? "true").toLowerCase() !== "false"; }

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
// we don't want to starve trading when the broker snapshot lacks depth fields.
function checkSpread(bid, ask, maxSpreadPts = liveMaxSpreadPts()) {
  if (!bid || !ask || ask <= 0 || bid <= 0 || ask < bid) {
    return { ok: true, spread: null, reason: "no-quote" };
  }
  const spread = parseFloat((ask - bid).toFixed(2));
  return { ok: !liveSpreadCheckEnabled() || spread <= maxSpreadPts, spread, reason: `bid=${bid} ask=${ask} spread=${spread}pt` };
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

// ── Global profit lock (ratchet) ──────────────────────────────────────────
//
// One rule for EVERY strategy, present and future. Not a per-strategy key by
// design: a new engine inherits it by calling checkProfitLock() in its per-tick
// exit path, with nothing to configure and no way to forget a toggle.
//
// WHY IT EXISTS — measured, not assumed. Over 346 recorded paper trades
// (Jul–Sep 2026, all engines), losing trades reached their peak a median of
// 3 minutes after entry at a median +6 spot pts, while winners peaked a median
// of 25 minutes in at +39.5 pts. So an early, small premium gain is a REVERSAL
// signature, not an edge: 39% of trades ever touched +8% premium, and most of
// those round-tripped to a loss. Replaying the same trades with arm +8% /
// floor +5% turns the active-strategy book from -Rs6,028 to +Rs32,110, with
// only 72 of 344 trades' exits changed.
//
// WHY THESE NUMBERS — a grid search scored arm +12% / floor +10% highest
// (+Rs37,016), but that is the in-sample optimum and almost certainly overfit
// to this small sample. +8/+5 is the deliberately un-tuned choice: it arms
// earlier, gives back less, and still captures the bulk of the improvement.
// Treat both as hypotheses until a forward paper session confirms them.
//
// SEMANTICS — a one-way ratchet. Once premium has touched entry × (1 + arm),
// the position may never again be sold below entry × (1 + floor). It only ever
// tightens; it never widens a stop, never moves a stop against the trade, and
// never fires before the arm threshold is reached. It does not cap the upside:
// a runner that keeps climbing is never sold while it climbs. With the trail
// (PROFIT_LOCK_TRAIL_PCT) the floor rises with the peak, so a runner gives back
// at most (100 − trail)% of its best gain before the lock takes it.
//
// CALLER CONTRACT — call per tick with the LIVE option premium and the peak
// premium seen so far (engines already track this as bestOptionLtp). Returns an
// exit-reason string when the lock should fire, else null. Both prices must be
// the option premium, never spot.
function liveProfitLockArmPct()   { return parseFloat(process.env.PROFIT_LOCK_ARM_PCT   || "8"); }
function liveProfitLockFloorPct() { return parseFloat(process.env.PROFIT_LOCK_FLOOR_PCT || "5"); }
// Default OFF: unset = no profit lock in any strategy. Turn it on from Settings → Common Rules.
function liveProfitLockEnabled()  { return String(process.env.PROFIT_LOCK_ENABLED ?? "false").toLowerCase() === "true"; }
// TRAIL — once armed, the floor also follows the peak: it is never below
// entry + TRAIL% of the best premium gain so far (0 = off, fixed floor only).
// Added 2026-10-01 after a V2 PE ran 142.75 → 330 with the floor stuck at
// 149.89. Example at 70: peak 330 → gain 187.25 → floor 142.75 + 131.07 = 273.82.
// It only ever rises with the peak, so it never widens the fixed floor.
function liveProfitLockTrailPct() { return parseFloat(process.env.PROFIT_LOCK_TRAIL_PCT ?? "70"); }

// TIERS — a tighter trail for small peaks. Live data (502 trades, Jul–Oct
// 2026): 144 trades peaked ≥+10% premium, and a flat 70% trail still hands back
// 3 points of a 10% move. A small early peak is the reversal signature, so it
// keeps more; a big runner keeps less, so a normal pullback does not shake it
// out. Format "upToGain%:keep%,…" — default "20:85,40:80": below +20% keep 85%
// of the gain, below +40% keep 80%, above that PROFIT_LOCK_TRAIL_PCT (70).
// Example: entry 100, peak 110 → floor 108.5 (was 107); peak 150 → floor 135.
// Blank = flat trail only. Peak-on-peak replay: +Rs27.9k vs +Rs21.5k for the
// flat 70% since 21-Sep — an upper bound, it cannot see shake-outs.
function liveProfitLockTrailTiers() { return process.env.PROFIT_LOCK_TRAIL_TIERS ?? "20:85,40:80"; }

function parseTrailTiers(spec) {
  return String(spec || "").split(",").map(t => t.split(":").map(Number))
    .filter(([upTo, keep]) => upTo > 0 && keep > 0 && keep < 100)
    .map(([upTo, keep]) => ({ upTo, keep }))
    .sort((a, b) => a.upTo - b.upTo);
}

// The % of the best gain the trail keeps, for a peak gain of gainPct (% of
// entry). 0 when the trail is off — TRAIL_PCT 0 switches the tiers off too, so
// old replays that force it to 0 stay fixed-floor. The floor never falls as the
// peak rises: at each tier edge the floor reached there is carried forward, so
// a lower keep % for a bigger peak can never pull the floor back down.
function profitLockTrailKeepPct(gainPct, trailPct, tiersSpec = liveProfitLockTrailTiers()) {
  if (!Number.isFinite(trailPct) || trailPct <= 0 || trailPct >= 100) return 0;
  if (!Number.isFinite(gainPct) || gainPct <= 0) return 0;
  let carried = 0;                 // gain % kept at the last tier edge passed
  let keep = trailPct;
  for (const t of parseTrailTiers(tiersSpec)) {
    if (gainPct < t.upTo) { keep = t.keep; break; }
    carried = Math.max(carried, t.upTo * t.keep / 100);
  }
  return gainPct * keep / 100 >= carried ? keep : carried / gainPct * 100;
}

// The floor premium for an armed lock: the fixed floor, raised by the trail.
// Shared with the backtests so their spot-equivalent floor matches paper.
function profitLockFloorLtp(entryLtp, bestLtp, floorPct, trailPct, tiersSpec = liveProfitLockTrailTiers()) {
  let floor = entryLtp * (1 + floorPct / 100);
  if (bestLtp > entryLtp) {
    const keep = profitLockTrailKeepPct((bestLtp / entryLtp - 1) * 100, trailPct, tiersSpec);
    floor = Math.max(floor, entryLtp + (bestLtp - entryLtp) * keep / 100);
  }
  return parseFloat(floor.toFixed(2));
}

// The armed profit-lock floor, or null when the lock is off, misconfigured or
// not yet armed. Misconfiguration must never invert the ratchet into a wider stop.
function _lockFloorLtp(entryLtp, bestLtp, { armPct, floorPct, enabled, trailPct, tiers }) {
  if (!enabled) return null;
  if (!Number.isFinite(bestLtp) || bestLtp <= 0) return null;
  if (!Number.isFinite(armPct) || !Number.isFinite(floorPct)) return null;
  if (armPct <= 0 || floorPct < 0 || floorPct >= armPct)      return null;
  if (bestLtp < entryLtp * (1 + armPct / 100)) return null;   // never armed — no lock yet
  return profitLockFloorLtp(entryLtp, bestLtp, floorPct, trailPct, tiers);
}

// ── Premium stop-loss (all strategies) ──────────────────────────────────────
// One stop for every strategy, on the option premium, checked in the same
// per-tick call as the profit lock (checkProfitLock), so every engine that
// runs the lock runs this too. Three steps:
//   1. Start: sell if premium falls PREMIUM_SL_PCT % below entry.
//   2. Once premium has touched +PREMIUM_SL_BE_PCT %, the stop moves up to entry.
//   3. From then on it also trails PREMIUM_SL_TRAIL_PTS rupees below the peak
//      (0 = stay at entry). It only ever moves up.
// Example (20 / 20 / 15): buy 100 → stop 80. Peak 120 → stop 105. Peak 150 → stop 135.
// Default OFF: unset = no strategy uses it. Turn it on from Settings → Common Rules.
function livePremiumSlEnabled()  { return String(process.env.PREMIUM_SL_ENABLED ?? "false").toLowerCase() === "true"; }
function livePremiumSlPct()      { return parseFloat(process.env.PREMIUM_SL_PCT ?? "20"); }
function livePremiumSlBePct()    { return parseFloat(process.env.PREMIUM_SL_BE_PCT ?? "20"); }
function livePremiumSlTrailPts() { return parseFloat(process.env.PREMIUM_SL_TRAIL_PTS ?? "15"); }

// The stop premium for a position, or null when off or misconfigured.
function premiumStopLtp(entryLtp, bestLtp, {
  enabled  = livePremiumSlEnabled(),
  slPct    = livePremiumSlPct(),
  bePct    = livePremiumSlBePct(),
  trailPts = livePremiumSlTrailPts(),
} = {}) {
  if (!enabled) return null;
  if (!Number.isFinite(entryLtp) || entryLtp <= 0) return null;
  if (!Number.isFinite(slPct) || slPct <= 0 || slPct >= 100) return null;
  if (!Number.isFinite(bePct) || bePct <= 0) return null;
  if (!Number.isFinite(trailPts) || trailPts < 0) return null;
  let stop = entryLtp * (1 - slPct / 100);
  if (Number.isFinite(bestLtp) && bestLtp >= entryLtp * (1 + bePct / 100)) {
    stop = Math.max(entryLtp, trailPts > 0 ? bestLtp - trailPts : entryLtp);
  }
  return parseFloat(stop.toFixed(2));
}

// The premium stop in SPOT points for the backtests that have no live premium
// (they model premium as seed + spot × delta). bestFavPts = best favourable spot
// move so far. Returns the stop's favourable distance from entry in spot points
// (negative = below entry), or null when the stop is off.
// Example: seed 200, delta 0.5, SL 20% → −80 pts until the peak reaches +80 pts.
function premiumStopSpotPts(bestFavPts, delta, seed = 200) {
  if (!Number.isFinite(delta) || delta <= 0) return null;
  const fav = Number.isFinite(bestFavPts) && bestFavPts > 0 ? bestFavPts : 0;
  const stop = premiumStopLtp(seed, seed + fav * delta);
  return stop == null ? null : (stop - seed) / delta;
}

// Exit reason for a spot-point premium stop (see premiumStopSpotPts).
function premiumStopSpotReason(stopPts, bestFavPts) {
  if (stopPts < 0) return `Stop-loss -${livePremiumSlPct()}% (≈${(-stopPts).toFixed(0)}pt spot below entry)`;
  if (stopPts === 0) return `Stop-loss breakeven (peak ≈${(bestFavPts || 0).toFixed(0)}pt spot)`;
  return `Stop-loss trail (≈${stopPts.toFixed(0)}pt spot kept of ${(bestFavPts || 0).toFixed(0)}pt best)`;
}

function _premiumStopOpts(o) {
  return { enabled: o.slEnabled, slPct: o.slPct, bePct: o.slBePct, trailPts: o.slTrailPts };
}

function _lockOpts(o) {
  return {
    armPct:   o.armPct   ?? liveProfitLockArmPct(),
    floorPct: o.floorPct ?? liveProfitLockFloorPct(),
    enabled:  o.enabled  ?? liveProfitLockEnabled(),
    trailPct: o.trailPct ?? liveProfitLockTrailPct(),
    tiers:    o.tiers    ?? liveProfitLockTrailTiers(),
  };
}

// The premium an exit from checkProfitLock fills at when price crosses it: the
// higher of the armed profit-lock floor and the premium stop, or null if neither
// is active. Backtests use it to fill an adverse-leg exit at the level, not the extreme.
// Takes the same options object as checkProfitLock.
function exitLevelLtp(entryLtp, bestLtp, opts = {}) {
  if (!Number.isFinite(entryLtp) || entryLtp <= 0) return null;
  const lock = _lockFloorLtp(entryLtp, bestLtp, _lockOpts(opts));
  const stop = premiumStopLtp(entryLtp, bestLtp, _premiumStopOpts(opts));
  if (lock == null) return stop;
  if (stop == null) return lock;
  return Math.max(lock, stop);
}

// Options: armPct / floorPct / enabled / trailPct / tiers for the profit lock,
// slEnabled / slPct / slBePct / slTrailPts for the premium stop. Any key left
// out falls back to its live env value.
function checkProfitLock(entryLtp, currentLtp, bestLtp, opts = {}) {
  if (!Number.isFinite(entryLtp) || entryLtp <= 0)     return null;
  if (!Number.isFinite(currentLtp) || currentLtp <= 0) return null;
  const lo = _lockOpts(opts);
  const floorLtp = _lockFloorLtp(entryLtp, bestLtp, lo);
  const stopLtp  = premiumStopLtp(entryLtp, bestLtp, _premiumStopOpts(opts));
  if (floorLtp == null && stopLtp == null) return null;

  const entryR = parseFloat(entryLtp.toFixed(2));
  const peakR  = Number.isFinite(bestLtp) ? parseFloat(bestLtp.toFixed(2)) : entryR;
  // The higher level is the one price reaches first on the way down.
  if (floorLtp != null && (stopLtp == null || floorLtp >= stopLtp)) {
    if (currentLtp > floorLtp) return null;          // still above the locked floor
    const fixedFloor = parseFloat((entryLtp * (1 + lo.floorPct / 100)).toFixed(2));
    if (floorLtp > fixedFloor) {
      const keptOfGain = Math.round((floorLtp - entryLtp) / (bestLtp - entryLtp) * 100);
      return `Profit lock trail ${keptOfGain}% — premium Rs${currentLtp} fell to the trailed floor Rs${floorLtp} (keeps ${keptOfGain}% of the gain to peak Rs${peakR}, entry Rs${entryR})`;
    }
    return `Profit lock +${lo.floorPct}% — premium Rs${currentLtp} fell to the locked floor Rs${floorLtp} after peaking at Rs${peakR} (armed at +${lo.armPct}%, entry Rs${entryR})`;
  }

  if (currentLtp > stopLtp) return null;             // still above the stop
  if (stopLtp < entryLtp) {
    const pct = Math.round((1 - stopLtp / entryLtp) * 100);
    return `Stop-loss -${pct}% — premium Rs${currentLtp} fell to the stop Rs${stopLtp} (entry Rs${entryR})`;
  }
  if (stopLtp > entryR) {
    return `Stop-loss trail — premium Rs${currentLtp} fell to the trailed stop Rs${stopLtp} (peak Rs${peakR}, entry Rs${entryR})`;
  }
  return `Stop-loss breakeven — premium Rs${currentLtp} fell back to entry Rs${stopLtp} (peak Rs${peakR})`;
}

// ── Re-entry cooldown after ANY exit (all strategies) ───────────────────────
// Once a position closes — profit lock, manual exit, session end, any reason —
// no new entry on EITHER side until EXIT_REENTRY_COOLDOWN_CANDLES of
// the strategy's own candles have passed. Stops the bot re-buying on the very
// next candle after it was just shaken out (23 Oct: exit 10:48, same PE
// re-entered 10:50, out again 10:53). 0 = off.
//
// Measured from the EXIT time: exit 10:48:49 on 5-min candles with 2 → blocked
// until 10:58:49. Backtests stand in the exit bar's open time for a tick exit
// and its close time for a candle-close exit.
// Manual entries bypass it.
function liveReentryCooldownCandles() {
  if (String(process.env.EXIT_REENTRY_COOLDOWN_ENABLED ?? "true").toLowerCase() === "false") return 0;
  const n = parseInt(process.env.EXIT_REENTRY_COOLDOWN_CANDLES ?? "2", 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
// Cooldown length in ms for a strategy running on `resMin`-minute candles.
function reentryCooldownMs(resMin) {
  const n = liveReentryCooldownCandles();
  const r = parseFloat(resMin);
  return n > 0 && Number.isFinite(r) && r > 0 ? n * r * 60 * 1000 : 0;
}
// Epoch-ms until which entries stay blocked after an exit at `exitMs`; 0 = no block.
function reentryCooldownUntil(exitMs, resMin) {
  const ms = reentryCooldownMs(resMin);
  return ms > 0 && Number.isFinite(exitMs) ? exitMs + ms : 0;
}

module.exports = {
  fetchOptionQuote,
  checkSpread,
  checkProfitLock,
  profitLockFloorLtp,
  profitLockTrailKeepPct,
  premiumStopLtp,
  premiumStopSpotPts,
  premiumStopSpotReason,
  exitLevelLtp,
  reentryCooldownMs,
  reentryCooldownUntil,
  INDICATOR_HISTORY_CANDLES,
  // Live getters (kept under the old names for callers that read them for display).
  get DEFAULT_MAX_SPREAD_PTS()     { return liveMaxSpreadPts(); },
  get PROFIT_LOCK_ENABLED()        { return liveProfitLockEnabled(); },
  get PROFIT_LOCK_ARM_PCT()        { return liveProfitLockArmPct(); },
  get PROFIT_LOCK_FLOOR_PCT()      { return liveProfitLockFloorPct(); },
  get PROFIT_LOCK_TRAIL_PCT()      { return liveProfitLockTrailPct(); },
  get PROFIT_LOCK_TRAIL_TIERS()    { return liveProfitLockTrailTiers(); },
  get PREMIUM_SL_ENABLED()         { return livePremiumSlEnabled(); },
  get PREMIUM_SL_PCT()             { return livePremiumSlPct(); },
  get PREMIUM_SL_BE_PCT()          { return livePremiumSlBePct(); },
  get PREMIUM_SL_TRAIL_PTS()       { return livePremiumSlTrailPts(); },
  get EXIT_REENTRY_COOLDOWN_CANDLES() { return liveReentryCooldownCandles(); },
};

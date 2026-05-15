/**
 * STRADDLE — Long Straddle (volatility play, paired CE+PE buying)
 * ─────────────────────────────────────────────────────────────────────────────
 * Textbook event/volatility setup taught in every options course:
 *   • Buy 1 ATM CE  + Buy 1 ATM PE same expiry, same strike
 *   • Position is direction-agnostic — profits if NIFTY moves enough either way
 *   • Risk = total premium paid (capped, finite)
 *   • Profits from: (a) directional move bigger than total premium, OR
 *                    (b) IV expansion that lifts both legs
 *
 * Entry triggers (ANY one must be true, ALL must be in good shape):
 *   1. Bollinger Band SQUEEZE — bandwidth < ORB_SQUEEZE_AVG_PCT × 20-day avg
 *      → volatility compression about to expand
 *   2. Pre-event day — calendar flag (RBI / monthly expiry / results day)
 *      → user flips STRADDLE_FORCE_ENTRY_NEXT for one-shot setups
 *   3. Low-VIX cheap-premium window — VIX < STRADDLE_VIX_CHEAP (default 14)
 *      → straddle is structurally cheap; even a normal day's move can pay
 *
 * Filters that block entry regardless:
 *   • VIX > STRADDLE_VIX_MAX_ENTRY (default 22) — premium already pumped, poor R:R
 *   • Outside entry window (default 9:30–11:00 IST). Late-day straddles bleed.
 *   • Already in a paired position.
 *
 * Exit (handled by route):
 *   • Target: +STRADDLE_TARGET_PCT of combined net debit (default 40%)
 *   • SL:     −STRADDLE_STOP_PCT of combined net debit (default 25%)
 *   • Time stop: T-1 of expiry OR STRADDLE_MAX_HOLD_DAYS (default 3) days
 *
 * Returns: { signal, reason, trigger, bbWidth, bbWidthAvg, vix, signalStrength }
 *   signal: "ENTER_STRADDLE" | "NONE"
 */

const { BollingerBands } = require("technicalindicators");

const NAME        = "STRADDLE_VOL";
const DESCRIPTION = "Long Straddle — paired ATM CE+PE buying on volatility compression / event days";

function _parseMins(envKey, fallback) {
  const v = (process.env[envKey] || fallback).trim();
  const parts = v.split(":");
  return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
}

function _utcSecToIstMins(unixSec) {
  return Math.floor((unixSec + 19800) / 60) % 1440;
}

/**
 * getSignal(candles, opts) — evaluates whether to OPEN a new straddle.
 *
 * @param {Array} candles — 5-min spot candles, latest last
 * @param {object} [opts]
 *   silent — suppress console.log
 *   alreadyOpen — true if a straddle position already exists (returns NONE)
 *   vix — current VIX (number) or null
 */
function getSignal(candles, opts) {
  const silent = !!(opts && opts.silent);
  const alreadyOpen = !!(opts && opts.alreadyOpen);
  const vix = (opts && opts.vix != null) ? opts.vix : null;

  const base = {
    signal:         "NONE",
    trigger:        null,
    bbWidth:        null,
    bbWidthAvg:     null,
    vix,
    signalStrength: null,
    reason:         "",
  };

  if (alreadyOpen) {
    return Object.assign({}, base, { reason: "Straddle position already open — at most 1 paired position at a time" });
  }

  if (!candles || candles.length < 25) {
    return Object.assign({}, base, { reason: `Warming up (${candles ? candles.length : 0}/25 candles for BB squeeze detection)` });
  }

  // ── Entry window ────────────────────────────────────────────────────────
  const entryStart = _parseMins("STRADDLE_ENTRY_START", "09:30");
  const entryEnd   = _parseMins("STRADDLE_ENTRY_END",   "11:00");
  const last = candles[candles.length - 1];
  const lastIst = _utcSecToIstMins(last.time);
  if (lastIst < entryStart) return Object.assign({}, base, { reason: `Before ${process.env.STRADDLE_ENTRY_START || "09:30"} IST — waiting` });
  if (lastIst >= entryEnd)  return Object.assign({}, base, { reason: `Past ${process.env.STRADDLE_ENTRY_END || "11:00"} IST — late straddles bleed theta` });

  // ── VIX gate ────────────────────────────────────────────────────────────
  // High VIX = premium already pumped, poor R:R for buyer
  const vixMax = parseFloat(process.env.STRADDLE_VIX_MAX_ENTRY || "22");
  if (vix != null && vix > vixMax) {
    return Object.assign({}, base, { reason: `VIX ${vix.toFixed(1)} > ${vixMax} — premium pumped, blocked` });
  }

  // ── Trigger 1: Bollinger Band squeeze ───────────────────────────────────
  const bbPeriod = parseInt(process.env.STRADDLE_BB_PERIOD || "20", 10);
  const bbStd    = parseFloat(process.env.STRADDLE_BB_STDDEV || "2");
  const closes = candles.map(c => c.close);
  let bb;
  try {
    bb = BollingerBands.calculate({ period: bbPeriod, values: closes, stdDev: bbStd });
  } catch (_) { bb = []; }
  if (bb.length < 1) {
    return Object.assign({}, base, { reason: "BB indicator not ready" });
  }
  const cur = bb[bb.length - 1];
  const bbWidthCur = (cur.upper - cur.lower) / cur.middle;   // normalised bandwidth
  // Average BB width over last N closed periods (skip the current one)
  const lookback = parseInt(process.env.STRADDLE_BB_AVG_LOOKBACK || "20", 10);
  const tail = bb.slice(-1 - lookback, -1);
  const widths = tail.map(b => (b.upper - b.lower) / b.middle);
  const avg = widths.length ? widths.reduce((a, b) => a + b, 0) / widths.length : null;
  const squeezeRatio = parseFloat(process.env.STRADDLE_SQUEEZE_RATIO || "0.85"); // current bandwidth must be <= 85% of avg
  const isSqueeze = avg != null && bbWidthCur <= avg * squeezeRatio;

  // ── Trigger 2: low-VIX cheap-premium window ─────────────────────────────
  const vixCheap = parseFloat(process.env.STRADDLE_VIX_CHEAP || "14");
  const isCheapPremium = vix != null && vix < vixCheap;

  // ── Trigger 3: one-shot user override (event days like RBI/budget) ──────
  // User flips STRADDLE_FORCE_ENTRY_NEXT in Settings before a known event.
  // The route auto-clears this flag after one entry fires.
  const isForced = (process.env.STRADDLE_FORCE_ENTRY_NEXT || "false").toLowerCase() === "true";

  let trigger = null;
  if (isForced)             trigger = "FORCED_EVENT";
  else if (isSqueeze)       trigger = "BB_SQUEEZE";
  else if (isCheapPremium)  trigger = "LOW_VIX_CHEAP";

  if (!trigger) {
    const widthPct = bbWidthCur.toFixed(4);
    const avgStr = avg != null ? avg.toFixed(4) : "n/a";
    return Object.assign({}, base, {
      bbWidth: parseFloat(widthPct),
      bbWidthAvg: avg != null ? parseFloat(avgStr) : null,
      reason: `No trigger — BB width ${widthPct} vs avg ${avgStr} (squeeze<${squeezeRatio} of avg), VIX ${vix == null ? "n/a" : vix.toFixed(1)} >= ${vixCheap} cheap-threshold, force=false`,
    });
  }

  // ── Signal strength ─────────────────────────────────────────────────────
  // STRONG when (a) deep squeeze (cur < 0.75 of avg) OR (b) VIX very low (<12)
  // OR (c) forced event override.
  const isStrong = (isSqueeze && avg != null && bbWidthCur <= avg * 0.75) ||
                   (vix != null && vix < 12) ||
                   isForced;
  const strength = isStrong ? "STRONG" : "MARGINAL";

  if (!silent) {
    const istStr = new Date(last.time * 1000).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: false });
    console.log(`[STRADDLE ${istStr}] TRIGGER=${trigger} | BBwidth=${bbWidthCur.toFixed(4)} vs avg=${avg != null ? avg.toFixed(4) : "n/a"} | VIX=${vix == null ? "n/a" : vix.toFixed(1)} [${strength}]`);
  }

  return Object.assign({}, base, {
    signal:         "ENTER_STRADDLE",
    trigger,
    bbWidth:        Math.round(bbWidthCur * 10000) / 10000,
    bbWidthAvg:     avg != null ? Math.round(avg * 10000) / 10000 : null,
    signalStrength: strength,
    reason: `${trigger} | BBwidth=${bbWidthCur.toFixed(4)} avg=${avg != null ? avg.toFixed(4) : "n/a"} | VIX=${vix == null ? "n/a" : vix.toFixed(1)} [${strength}]`,
  });
}

module.exports = { NAME, DESCRIPTION, getSignal };

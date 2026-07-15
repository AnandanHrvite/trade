/**
 * OI + PRICE BUILDUP FILTER — directional entry gate (per-module toggles)
 * ─────────────────────────────────────────────────────────────────────────────
 * Blocks entries that fight the prevailing Open-Interest buildup. Reads NIFTY
 * current-expiry FUTURES OI (via Fyers getQuotes) against NIFTY spot over a short
 * lookback, then classifies the regime (the classic price+OI four-quadrant model):
 *
 *   Price ↑ + OI ↑ = LONG_BUILDUP   (bullish) → block PE, allow CE
 *   Price ↓ + OI ↑ = SHORT_BUILDUP  (bearish) → block CE, allow PE
 *   Price ↑ + OI ↓ = SHORT_COVERING (weak)    → allow
 *   Price ↓ + OI ↓ = LONG_UNWINDING (weak)    → allow
 *   |ΔOI| < min%   = NEUTRAL                   → allow
 *
 * Policy: only block when fighting a *confirmed* strong buildup. Weak / neutral /
 * warmup / OI-missing all fail OPEN (allow). This is a pure LIVE/PAPER overlay.
 * Replay/backtest safety: no backtest engine imports this module (there is
 * deliberately no checkBacktestOi). Tick-replay DOES drive the paper routes, but
 * the replay harness stubs fyers.getQuotes on the shared singleton, so any OI
 * fetch during replay returns recorded/no-data and never hits the network →
 * the series stays empty and the gate fails open, leaving recordings untouched.
 * The routes' !_simMode guards exist for the in-process /sim synthetic-scenario
 * tester (which does NOT stub getQuotes); ORB has no /sim tester so needs none.
 *
 * Toggles (all OFF by default):
 *   Master  : OI_FILTER_ENABLED          — kill-switch for every strategy
 *   Per-mode: EMA_RSI_ST_OI_ENABLED, BB_RSI_OI_ENABLED, PA_OI_ENABLED, ORB_OI_ENABLED
 *   Tuning  : OI_LOOKBACK_CANDLES (3), OI_MIN_DELTA_PCT (1.0)
 *             OI_FAIL_MODE (open) — symmetry with VIX; default & documented = open
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */

const fyers            = require("../config/fyers");
const instrumentConfig = require("../config/instrument");
const tickRecorder     = require("../utils/tickRecorder");

const PRICE_EPS_PTS = 1;       // ignore micro spot drift over the lookback
const SAMPLE_TTL    = 60_000;  // throttle: at most one OI fetch per 60s (≈ 1/candle at 5m)
const STALE_GAP_MS  = 30 * 60_000; // gap > 30m (overnight / long pause) ⇒ discard stale series

// ── Per-mode config readers (live — never cached, so toggles apply instantly) ──
function getOiEnabled(mode = "ema_rsi_st") {
  if (process.env.OI_FILTER_ENABLED !== "true") return false; // master kill-switch
  if (mode === "bb_rsi") return process.env.BB_RSI_OI_ENABLED === "true";
  if (mode === "pa")    return process.env.PA_OI_ENABLED    === "true";
  if (mode === "orb")   return process.env.ORB_OI_ENABLED   === "true";
  if (mode === "trend_pb") return process.env.TREND_PB_OI_ENABLED === "true";
  return process.env.EMA_RSI_ST_OI_ENABLED === "true"; // EMA_RSI_ST
}

// `mode` is accepted for call-site symmetry but ignored — only global OI_* tuning
// keys exist today. Add EMA_RSI_ST_OI_LOOKBACK etc. here if per-mode tuning is ever wanted.
function getOiLookback(mode = "ema_rsi_st") {
  const n = parseInt(process.env.OI_LOOKBACK_CANDLES || "3", 10);
  return Number.isFinite(n) && n >= 1 ? n : 3;
}

function getOiMinDelta(mode = "ema_rsi_st") {
  // Honor an explicit 0 (no noise floor) — Settings exposes min:0. Falsy `|| 1`
  // would silently coerce 0→1, so clamp on validity instead.
  const v = parseFloat(process.env.OI_MIN_DELTA_PCT);
  return Number.isFinite(v) && v >= 0 ? v : 1;
}

function anyOiEnabled() {
  return getOiEnabled("ema_rsi_st") || getOiEnabled("bb_rsi") ||
         getOiEnabled("pa")    || getOiEnabled("orb") || getOiEnabled("trend_pb");
}

// ── Shared OI series (ring buffer of {ts, oi, spot}, one sample per ~candle) ───
let _series      = [];     // newest at the end
let _lastSampleTs = 0;
let _lastRegime  = null;
let _warnedNoOi  = false;  // rate-limit the "no OI" warn (avoids per-candle spam in replay/outage)

function _futSymbol() {
  // Always the NIFTY futures contract — the OI buildup proxy, independent of the
  // options-bot INSTRUMENT setting.
  return `NSE:NIFTY${instrumentConfig.getFuturesExpiry()}FUT`;
}

/**
 * Fetch NIFTY futures OI and push a {ts, oi, spot} sample. Throttled to one fetch
 * per SAMPLE_TTL so candle-close + entry-gate calls in the same candle dedupe.
 * Called on every candle close (even no-signal) so the series fills at the
 * strategy's native cadence. Fails silent — the series simply does not grow.
 */
async function recordOiSample(spot, { force = false } = {}) {
  if (!force && !anyOiEnabled()) return;
  if (!(spot > 0)) return;

  const now = Date.now();
  if (!force && (now - _lastSampleTs) < SAMPLE_TTL) return; // already sampled this candle

  try {
    const response = await fyers.getQuotes([_futSymbol()]);
    if (response && response.s === "ok" && response.d && response.d.length > 0) {
      const v  = response.d[0].v || response.d[0];
      const oi = Number(v.oi ?? v.open_interest ?? v.openInterest ?? 0);
      if (oi > 0) {
        // Discard stale samples (overnight / long pause) so ΔOI never spans sessions.
        if (_series.length && (now - _series[_series.length - 1].ts) > STALE_GAP_MS) _series = [];
        _lastSampleTs = now;
        _series.push({ ts: now, oi, spot });
        // Record OI (cache fills only, like VIX) so tick-replay can reproduce the
        // gate instead of failing it open. No-op'd during replay by the harness.
        try { tickRecorder.recordOi(_futSymbol(), oi); } catch (_) {}
        _warnedNoOi = false;
        // Keep a little more than the deepest lookback we might use.
        const maxLen = Math.max(getOiLookback() + 2, 6);
        if (_series.length > maxLen) _series.splice(0, _series.length - maxLen);
        return;
      }
    }
    if (!_warnedNoOi) { console.warn(`[OI] getQuotes returned no OI for ${_futSymbol()} (s=${response && response.s}) — failing open until OI returns`); _warnedNoOi = true; }
  } catch (err) {
    if (!_warnedNoOi) { console.warn(`[OI] Fetch failed: ${err.message} — failing open`); _warnedNoOi = true; }
  }
}

/**
 * Classify the price+OI buildup regime over the lookback.
 * @param {number} dPrice  spot change (points) over the lookback
 * @param {number} dOiPct  OI change (percent) over the lookback
 * @param {number} minDeltaPct  noise floor — |ΔOI| below this is NEUTRAL
 */
function classifyBuildup(dPrice, dOiPct, minDeltaPct) {
  const oiUp   = dOiPct >=  minDeltaPct;
  const oiDown = dOiPct <= -minDeltaPct;
  const priceUp   = dPrice >  PRICE_EPS_PTS;
  const priceDown = dPrice < -PRICE_EPS_PTS;

  if ((!oiUp && !oiDown) || (!priceUp && !priceDown)) return "NEUTRAL";
  if (priceUp   && oiUp)   return "LONG_BUILDUP";    // bullish
  if (priceDown && oiUp)   return "SHORT_BUILDUP";   // bearish
  if (priceUp   && oiDown) return "SHORT_COVERING";  // weak bullish
  if (priceDown && oiDown) return "LONG_UNWINDING";  // weak bearish
  return "NEUTRAL";
}

/**
 * Classify the current series and decide allow/block for `side`. Pure — no fetch.
 * Shared by checkLiveOi (async, samples first) and checkCachedOi (sync, no sample).
 * Sets _lastRegime so getCachedRegime() reflects the decision for trade records.
 */
function _evaluate(side, mode) {
  const lookback = getOiLookback(mode);
  if (_series.length < lookback + 1) {
    return { allowed: true, oi: getCachedOi(), deltaOi: null, regime: null,
             reason: `OI warmup — ${_series.length}/${lookback + 1} samples (fail-open)` };
  }

  const latest = _series[_series.length - 1];
  const base   = _series[_series.length - 1 - lookback];
  if (!latest || !base || !(latest.oi > 0) || !(base.oi > 0)) {
    const failClosed = (process.env.OI_FAIL_MODE || "open").toLowerCase() === "closed";
    return { allowed: !failClosed, oi: getCachedOi(), deltaOi: null, regime: null,
             reason: `OI unavailable — ${failClosed ? "blocking (fail-closed)" : "allowing (fail-open)"}` };
  }

  const dOiPct   = ((latest.oi - base.oi) / base.oi) * 100;
  const dPrice   = latest.spot - base.spot;
  const minDelta = getOiMinDelta(mode);
  const regime   = classifyBuildup(dPrice, dOiPct, minDelta);
  _lastRegime = regime;

  const tag = `ΔOI ${dOiPct >= 0 ? "+" : ""}${dOiPct.toFixed(1)}% / Δspot ${dPrice >= 0 ? "+" : ""}${dPrice.toFixed(0)}pt over ${lookback}c`;

  // Block only when fighting a confirmed strong buildup.
  if (regime === "LONG_BUILDUP" && side === "PE") {
    return { allowed: false, oi: latest.oi, deltaOi: dOiPct, regime, reason: `OI LONG_BUILDUP (${tag}) — PE blocked` };
  }
  if (regime === "SHORT_BUILDUP" && side === "CE") {
    return { allowed: false, oi: latest.oi, deltaOi: dOiPct, regime, reason: `OI SHORT_BUILDUP (${tag}) — CE blocked` };
  }
  return { allowed: true, oi: latest.oi, deltaOi: dOiPct, regime, reason: `OI ${regime} (${tag}) — ${side} allowed` };
}

/**
 * Async gate: sample the current candle (throttle dedupes vs the background call),
 * then evaluate. Use from candle-close entry paths.
 * @param {"CE"|"PE"} side
 * @param {number} spot  current NIFTY spot (bar.close at the gate)
 * @param {object} [opts]
 * @param {"ema_rsi_st"|"bb_rsi"|"pa"|"orb"} [opts.mode="ema_rsi_st"]
 */
async function checkLiveOi(side, spot, { mode = "ema_rsi_st" } = {}) {
  if (!getOiEnabled(mode)) {
    return { allowed: true, oi: null, deltaOi: null, regime: null, reason: "OI filter disabled" };
  }
  await recordOiSample(spot);
  return _evaluate(side, mode);
}

/**
 * Synchronous gate: classify from the already-sampled series WITHOUT a fetch.
 * For tick handlers (e.g. EMA_RSI_ST intra-tick entry) that can't await — relies on the
 * per-candle background recordOiSample() to keep the series fresh.
 * @param {"CE"|"PE"} side
 * @param {object} [opts]
 * @param {"ema_rsi_st"|"bb_rsi"|"pa"|"orb"} [opts.mode="ema_rsi_st"]
 */
function checkCachedOi(side, { mode = "ema_rsi_st" } = {}) {
  if (!getOiEnabled(mode)) {
    return { allowed: true, oi: null, deltaOi: null, regime: null, reason: "OI filter disabled" };
  }
  return _evaluate(side, mode);
}

/** Latest sampled futures OI (for trade-record display; no fetch). */
function getCachedOi() {
  return _series.length ? _series[_series.length - 1].oi : null;
}

/** Last classified buildup regime (for trade-record display). */
function getCachedRegime() {
  return _lastRegime;
}

/**
 * Clear the OI series + regime. NOT called on session start/stop — the series is
 * global market data shared across the parallel strategies and stale entries are
 * auto-discarded by STALE_GAP_MS, so a per-session reset would wrongly wipe a
 * concurrently-running strategy's warmed series. Exported as a manual/admin utility.
 */
function resetCache() {
  _series       = [];
  _lastSampleTs = 0;
  _lastRegime   = null;
  _warnedNoOi   = false;
}

module.exports = {
  getOiEnabled,
  getOiLookback,
  getOiMinDelta,
  anyOiEnabled,
  recordOiSample,
  classifyBuildup,
  checkLiveOi,
  checkCachedOi,
  getCachedOi,
  getCachedRegime,
  resetCache,
};

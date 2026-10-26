/**
 * commodityPaper.js — PAPER engine for the COMMODITY (MCX crude / gold / silver)
 * copies of EMA_RSI_ST and EMA_RSI_ST_V2. One engine per commodity × strategy;
 * all of them may run at once.
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY A SEPARATE ENGINE, NOT A COPY OF emaRsiStPaper.js
 * The NIFTY paper routes are wired into shared machinery: the capital pool, the
 * portfolio-wide daily-loss lock, the shared socket and its 15:30 teardown, the
 * tick recorder, replay, OI/VIX gates, Start-All and the consolidated reports.
 * A commodity copy plugged into any of those could move a NIFTY decision (a
 * crude loss tripping the global daily lock; the NSE socket shutting at 15:30
 * and starving an 11 PM crude session). So this engine touches NONE of them:
 *
 *   • prices come from Fyers REST (history for closed candles, quotes for the
 *     live price) — no socket at all. Every running commodity engine shares ONE
 *     batched quote call (the hub below), so six engines cost one request per
 *     poll, not six, and cannot crowd the NIFTY engines' broker budget.
 *   • its own files under ~/trading-data/cmx/ — no shared trade logs
 *   • the one exception: money comes from the shared FYERS capital pool
 *     (FYERS_INV_AMOUNT), so a commodity loss shrinks what NIFTY can spend
 *   • the strategy RULES are the originals, called read-only:
 *       V1 → strategy1_sar_ema_rsi.getSignal (EMA_RSI_ST_* settings)
 *       V2 → ema_rsi_st_v2.getSignal / trailStop (EMA_RSI_ST_V2_* settings)
 *       PIVOT → pivot_ema_st.getSignal / exitCheck / trailStop (PIVOT_EMA_ST_* settings;
 *               no trend filter, no confirm candle, future stop on candle close only)
 *     so the signal is the same strategy; only timing, sizing and day guards
 *     are commodity-specific (CMX_* keys).
 *
 * Commodity-only additions on top of the NIFTY rules, all on every page:
 *   • a trend filter on entries (CMX_MIN_EMA_GAP_PCT, CMX_RSI_CE_MAX /
 *     CMX_RSI_PE_MIN) — see trendBlock();
 *   • the global breakeven stop on V2 too (NIFTY V2 has none), so every page
 *     shares breakeven → profit lock → profit-lock trail;
 *   • a premium stop (CMX_OPT_STOP_PCT) on V1 and V2 alike — V2's SuperTrend
 *     stop alone let crude losers run to −20%+ of premium;
 *   • a per-commodity daily loss cap (CMX_<COMMODITY>_MAX_DAILY_LOSS) on top of
 *     the per-strategy one, so crude can be held tighter than gold/silver;
 *   • the option series rolls to next month CMX_OPT_ROLL_DAYS before expiry.
 *
 * Exits otherwise mirror the NIFTY paper routes at their defaults. Left out on purpose:
 * the NIFTY-points features (EMA_RSI_ST_STOP_LOSS_PTS, EMA_RSI_ST_BREAKEVEN_PTS)
 * because a NIFTY point is not a crude or gold rupee, and the VIX / OI / spread gates,
 * which read NSE data. The per-tick stop is checked on each poll
 * (CMX_POLL_SECONDS), not on every tick.
 */

const fs   = require("fs");
const path = require("path");
const os   = require("os");

const fyers        = require("../config/fyers");
const optionFeed   = require("../utils/optionFeed");
const mcx          = require("./mcxContracts");
const tradeGuards  = require("../utils/tradeGuards");
const capitalPool  = require("../utils/capitalPool");
const confirmCandle = require("../utils/confirmCandle");
const mcxHolidays  = require("../utils/mcxHolidays");
const { sendTelegram, canSend } = require("../utils/notify");
const { trackPath } = require("../utils/tradePath");

const DATA_DIR = path.join(os.homedir(), "trading-data", "cmx");
const MAX_CANDLES = 400;
const LOG_MAX = 3000;   // a full MCX day of per-candle detail (~6 lines × ~170 candles); full copy via /status/log
// Per-commodity daily loss cap defaults. Crude lost ₹33k of the ₹37k Oct 2026
// commodity paper loss, at up to ₹4k a trade, so it is held tighter by default.
const CMX_MAX_LOSS_DEFAULT = { CRUDE: 1500, GOLD: 0, SILVER: 0 };

// ── small helpers ────────────────────────────────────────────────────────────
function _mins(raw, def) {
  const [h, m] = String(raw || def).split(":").map(Number);
  if (!Number.isFinite(h)) return _mins(def, def);
  return h * 60 + (Number.isFinite(m) ? m : 0);
}
function _num(v, def) { const n = parseFloat(v); return Number.isFinite(n) ? n : def; }
function _int(v, def) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : def; }
function _bool(v, def) { return String(v == null || v === "" ? def : v).toLowerCase() === "true"; }
function istMinutesOf(sec) { return Math.floor((sec + 19800) / 60) % 1440; }
function istNowMinutes() { return istMinutesOf(Math.floor(Date.now() / 1000)); }
function istDay(ms = Date.now()) { return new Date(ms + 19800000).toISOString().slice(0, 10); }
function istDow(ms = Date.now()) { return new Date(ms + 19800000).getUTCDay(); }
function istClock(ms = Date.now()) { return new Date(ms + 19800000).toISOString().slice(11, 19); }
function fmtMins(m) { return String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0"); }
function r2(n) { return Math.round(n * 100) / 100; }
function _tighterCap(a, b) { return a > 0 && b > 0 ? Math.min(a, b) : (a || b); }

// Telegram — plain sendTelegram, NOT notifyEntry/notifyExit: those also fire the
// NIFTY live-order hooks, and a commodity paper trade must never reach them.
function tg(key, lines) {
  if (!canSend(key)) return;
  sendTelegram(lines.filter((l) => l != null).join("\n")).catch(() => {});
}

// ── shared quote hub ─────────────────────────────────────────────────────────
// Engines declare which symbols they need and how urgently. Prices come from the
// shared websocket when it is up; otherwise one getQuotes call every
// CMX_POLL_SECONDS serves them all (every 30 s when nobody holds a trade or an
// armed signal — the price is then only for display).
const hub = {
  needs: new Map(),     // engineId → { symbols: [], fast: bool }
  last: {},             // symbol → { lp, at }
  nextAt: 0,
  busy: false,
  timer: null,
  lastErr: null,
};
function hubNeed(engineId, symbols, fast) {
  if (!symbols || !symbols.length) hub.needs.delete(engineId);
  else hub.needs.set(engineId, { symbols: symbols.filter(Boolean), fast: !!fast });
  if (hub.needs.size && !hub.timer) hub.timer = setInterval(hubTick, 1000);
  if (!hub.needs.size && hub.timer) { clearInterval(hub.timer); hub.timer = null; }
}
function hubUrgent() { hub.nextAt = 0; }
async function hubTick() {
  const syms = new Set();
  let fast = false;
  for (const n of hub.needs.values()) { n.symbols.forEach((x) => syms.add(x)); fast = fast || n.fast; }
  if (!syms.size) return;
  // Socket-first: each symbol streams on the shared Fyers websocket while it is
  // connected, and only a symbol with no fresh streamed price goes to REST.
  const rest = [];
  for (const x of syms) {
    optionFeed.track(`cmx-hub:${x}`, x, null);
    // A quiet MCX contract can go several seconds without a trade; its last
    // streamed price is still what a REST quote would return.
    const st = optionFeed.getFresh(x, 15000);
    if (!st) { rest.push(x); continue; }
    const prev = hub.last[x];
    if (!prev || st.at > prev.at) hub.last[x] = { lp: st.ltp, at: st.at };
  }
  if (!rest.length || hub.busy || Date.now() < hub.nextAt) return;
  const poll = Math.max(2, _int(process.env.CMX_POLL_SECONDS, 3));
  hub.nextAt = Date.now() + (fast ? poll : 30) * 1000;
  hub.busy = true;
  try {
    const list = rest;
    for (let i = 0; i < list.length; i += 50) {           // Fyers takes ≤ 50 per call
      const r = await fyers.getQuotes(list.slice(i, i + 50));
      if (r.s !== "ok") throw new Error(`quotes: ${r.message || r.s}`);
      const at = Date.now();
      for (const d of r.d || []) {
        const v = d.v || {};
        if (Number.isFinite(v.lp) && v.lp > 0) hub.last[d.n || v.symbol] = { lp: v.lp, at };
      }
    }
    hub.lastErr = null;
  } catch (err) { hub.lastErr = err.message; }
  finally { hub.busy = false; }
}

// V1 and V2 of one commodity read the same future at the same resolution, so a
// history answer is shared between them for a few seconds instead of asking
// Fyers twice. The same request in flight is joined, not repeated.
const _histShared = new Map();   // request key → { at, promise }
function sharedHistory(req) {
  const key = JSON.stringify(req);
  const now = Date.now();
  for (const [k, v] of _histShared) if (now - v.at > 5000) _histShared.delete(k);
  const hit = _histShared.get(key);
  if (hit) return hit.promise;
  const promise = fyers.getHistory(req);
  _histShared.set(key, { at: now, promise });
  promise.catch(() => _histShared.delete(key));
  return promise;
}

// ── strategy adapters — the ONLY place the two strategies differ ──────────────
const ADAPTERS = {
  V1: {
    rulesKey: "EMA_RSI_ST",
    signal(candles) {
      return require("../strategies/strategy1_sar_ema_rsi").getSignal(candles, { silent: true, skipTimeCheck: true });
    },
    slPauseCandles: () => _int(process.env.EMA_RSI_ST_SL_PAUSE_CANDLES, 3),
    oppCooldownOn:  () => _bool(process.env.EMA_RSI_ST_OPPOSITE_SIDE_COOLDOWN_ENABLED, "true"),
    oppCooldownCandles: () => _int(process.env.EMA_RSI_ST_OPPOSITE_SIDE_COOLDOWN_CANDLES, 3),
    consecLimit:    () => Math.max(0, _int(process.env.EMA_RSI_ST_MAX_CONSEC_LOSSES, 0)),
    // Initial stop seed: prev-candle (default) or EMA21 when protective.
    seedStop(side, price, sig) {
      let seed = sig.stopLoss != null ? sig.stopLoss : null;
      if ((process.env.EMA_RSI_ST_INITIAL_SL_MODE || "prev_candle").toLowerCase() === "ema21" && seed != null && sig.ema21 != null) {
        const protective = side === "CE" ? sig.ema21 < price : sig.ema21 > price;
        if (protective) seed = r2(sig.ema21);
      }
      return seed;
    },
    // Candle-close rules for an open position. Returns an exit reason or null.
    onClose(eng, pos, bar, sig) {
      // Negative-candle stop — still red after N candles → out.
      const negLimit = _int(process.env.EMA_RSI_ST_NEG_CANDLE_LIMIT, 2);
      const pnlPts = (pos.optionEntryLtp && eng.state.optLtp)
        ? eng.state.optLtp - pos.optionEntryLtp
        : (bar.close - pos.spotAtEntry) * (pos.side === "CE" ? 1 : -1);
      if (negLimit > 0 && pnlPts < 0 && pos.candlesHeld >= negLimit) return `Negative ${negLimit}-candle stop`;

      // EMA21 trail (+ optional N-bar candle trail), tighten-only.
      const closeMode = (process.env.EMA_RSI_ST_EMA_EXIT_MODE || "touch").toLowerCase() === "close";
      let newSL = null, tag = "";
      if (sig.ema21 != null && !closeMode) { newSL = sig.ema21; tag = "EMA21"; }
      const ctOn = _bool(process.env.EMA_RSI_ST_CANDLE_TRAIL_ENABLED, "false");
      const ctBars = Math.max(1, _int(process.env.EMA_RSI_ST_CANDLE_TRAIL_BARS, 3));
      const c = eng.state.candles;
      if (ctOn && c.length >= ctBars) {
        const bars = c.slice(-ctBars);
        const lvl = pos.side === "CE" ? Math.min(...bars.map((b) => b.low)) : Math.max(...bars.map((b) => b.high));
        if (newSL == null || (pos.side === "CE" ? lvl > newSL : lvl < newSL)) { newSL = lvl; tag = `${ctBars}-bar ${pos.side === "CE" ? "low" : "high"}`; }
      }
      if (newSL != null && (pos.stopLoss == null || (pos.side === "CE" ? newSL > pos.stopLoss : newSL < pos.stopLoss))) {
        eng.log(`📐 SL trail ${pos.side}: ${pos.stopLoss} → ${r2(newSL)} (${tag})`);
        pos.stopLoss = r2(newSL);
      }
      // EMA21 touch-back / close-through exit (never on the entry bar).
      if (sig.ema21 != null && bar.time !== pos.entryBarTime) {
        const flip = closeMode
          ? (pos.side === "CE" ? bar.close < sig.ema21 : bar.close > sig.ema21)
          : (bar.low <= sig.ema21 && bar.high >= sig.ema21);
        if (flip) return closeMode ? "EMA close-through exit" : "EMA touch-back exit";
      }
      return null;
    },
    // Chart overlays — the same periods the V1 rules read.
    chartCfg: () => ({
      emaFast: _int(process.env.EMA_RSI_ST_EMA_FAST, 20), emaSlow: _int(process.env.EMA_RSI_ST_EMA_SLOW, 50),
      stPeriod: _int(process.env.EMA_RSI_ST_SUPERTREND_PERIOD, 10), stMult: _num(process.env.EMA_RSI_ST_SUPERTREND_MULT, 3),
      rsiCeMin: _num(process.env.RSI_CE_MIN, 52), rsiPeMax: _num(process.env.RSI_PE_MAX, 48),
    }),
  },

  V2: {
    rulesKey: "EMA_RSI_ST_V2",
    signal(candles) {
      return require("../strategies/ema_rsi_st_v2").getSignal(candles, { prefix: "EMA_RSI_ST_V2", silent: true, skipTimeCheck: true });
    },
    slPauseCandles: () => _int(process.env.EMA_RSI_ST_V2_SL_PAUSE_CANDLES, 2),
    oppCooldownOn:  () => _bool(process.env.EMA_RSI_ST_V2_OPPOSITE_SIDE_COOLDOWN_ENABLED, "true"),
    oppCooldownCandles: () => _int(process.env.EMA_RSI_ST_V2_OPPOSITE_SIDE_COOLDOWN_CANDLES, 2),
    consecLimit:    () => Math.max(0, _int(process.env.EMA_RSI_ST_V2_MAX_CONSEC_LOSSES, 2)),
    seedStop(side, price, sig) { return Number.isFinite(sig.stopLoss) ? sig.stopLoss : null; },
    // SuperTrend trail is V2's stop on the future; no candle-close exits of its own.
    onClose(eng, pos) {
      const eng2 = require("../strategies/ema_rsi_st_v2");
      const t = eng2.trailStop(eng.state.candles, pos.side, pos.stopLoss, eng2.getConfig("EMA_RSI_ST_V2"));
      if (t && t.changed && Number.isFinite(t.stop)) {
        eng.log(`📐 SL trail ${pos.side}: ${pos.stopLoss} → ${t.stop} (SuperTrend)`);
        pos.stopLoss = t.stop;
      }
      return null;
    },
    chartCfg: () => {
      const k = require("../strategies/ema_rsi_st_v2").getConfig("EMA_RSI_ST_V2");
      return { emaFast: k.EMA_FAST, emaSlow: k.EMA_SLOW, stPeriod: k.ST_PERIOD, stMult: k.ST_MULT, rsiCeMin: k.RSI_CE_MIN, rsiPeMax: k.RSI_PE_MAX };
    },
  },

  // PIVOT_EMA_ST — rules from strategies/pivot_ema_st.js read with the NIFTY
  // PIVOT_EMA_ST_* keys (EMA / SuperTrend periods), the way V1 reads EMA_RSI_ST.
  // The optional flags below are read only where `A.<flag>` is checked in
  // createEngine; V1/V2 leave them undefined, so their behaviour is unchanged.
  PIVOT: {
    rulesKey: "PIVOT_EMA_ST",
    defaultRes: 3,               // CMX_PIVOT_EMA_ST_RESOLUTION default (V1/V2 keep 5)
    modeDefault: "true",         // CMX_<C>_PIVOT_EMA_ST_MODE_ENABLED default (V1/V2 keep "false")
    // Entry is on the signal candle's close. confirmCandle.enabled() would read
    // PIVOT_EMA_ST_CONFIRM_CANDLE_ENABLED with a default of "true" — the rules
    // have no confirmation candle, so it is forced off here.
    noConfirm: true,
    // The commodity trend filter (CMX_MIN_EMA_GAP_PCT / CMX_RSI_*) is a rule
    // filter the user did not ask for on PIVOT_EMA_ST — not applied. V1/V2 keep it.
    noTrendFilter: true,
    // Exits on the future are on CANDLE CLOSE only (exitCheck + trailStop in
    // onClose). The per-poll future-stop test in onPrice is skipped; the
    // premium-based common rules (option stop, breakeven, profit lock) still run per poll.
    candleCloseStopOnly: true,
    // Previous MCX day's daily H/L/C of the traded future — see ensurePivots().
    needsPivots: true,
    signal(candles, ctx) {
      const E = require("../strategies/pivot_ema_st");
      const k = E.getConfig("PIVOT_EMA_ST");
      // The candle size is CMX_PIVOT_EMA_ST_RESOLUTION, not PIVOT_EMA_ST_TF; TF is
      // only the reason tag here (skipTimeCheck — the engine applies its MCX window).
      if (ctx && Number.isFinite(ctx.res)) k.TF = ctx.res;
      return E.getSignal(candles, { prefix: "PIVOT_EMA_ST", cfg: k, pivots: (ctx && ctx.pivots) || null, silent: true, skipTimeCheck: true });
    },
    // SL pause, opposite-side cooldown and the consecutive-loss stop are V1/V2
    // rule keys (EMA_RSI_ST_*), not commodity-wide — PIVOT_EMA_ST has none.
    slPauseCandles: () => 0,
    oppCooldownOn:  () => false,
    oppCooldownCandles: () => 0,
    consecLimit:    () => 0,
    // Initial stop = the SuperTrend on the signal candle.
    seedStop(side, price, sig) { return Number.isFinite(sig.stopLoss) ? sig.stopLoss : null; },
    // The ONLY future-price exit: engine.exitCheck on this closed candle against
    // the stop in force before it, then engine.trailStop tighten-only.
    onClose(eng, pos, bar) {
      const E = require("../strategies/pivot_ema_st");
      const k = E.getConfig("PIVOT_EMA_ST");
      const candles = eng.state.candles;
      const st = E.computeSeries(candles, k).supertrend;
      const stBar = st[candles.length - 1] || null;
      const x = E.exitCheck(pos.side, bar, stBar, pos.stopLoss);
      if (x.exit) return x.reason;
      const t = E.trailStop(candles, pos.side, pos.stopLoss, k);
      if (t && t.changed && Number.isFinite(t.stop)) {
        eng.log(`📐 SL trail ${pos.side}: ${pos.stopLoss} → ${t.stop} (SuperTrend)`);
        pos.stopLoss = t.stop;
      }
      return null;
    },
    // Chart overlays come from engine.computeSeries — the exact numbers the signal read.
    chartCfg: () => {
      const k = require("../strategies/pivot_ema_st").getConfig("PIVOT_EMA_ST");
      return { emaFast: k.EMA_FAST, emaSlow: k.EMA_SLOW, stPeriod: k.ST_PERIOD, stMult: k.ST_MULT, rsiCeMin: null, rsiPeMax: null };
    },
    chartSeries(candles) {
      const E = require("../strategies/pivot_ema_st");
      return E.computeSeries(candles, E.getConfig("PIVOT_EMA_ST"));
    },
    // The per-candle indicator log line (V1/V2 print EMA20/EMA50/RSI/ST).
    candleLine(sig, f) {
      const k = sig.checks || {};
      const lv = sig.pp != null ? ` | PP=${sig.pp} R1=${sig.r1} S1=${sig.s1} (${sig.pivotsFrom || "?"})` : " | pivots: none";
      const box = (s) => (k[s] ? `${s} ${k[s].count}/3 [zone ${k[s].zone ? "✓" : "✗"} cross ${k[s].cross ? "✓" : "✗"} ST ${k[s].st ? "✓" : "✗"}]` : `${s} ?/3`);
      const p = require("../strategies/pivot_ema_st").getConfig("PIVOT_EMA_ST");
      return `   EMA${p.EMA_FAST}=${f(sig.emaFast)} EMA${p.EMA_SLOW}=${f(sig.emaSlow)} | ST=${f(sig.supertrend)}(${sig.stTrend || "?"})${lv} | ${box("CE")} · ${box("PE")}`;
    },
  },
};

/**
 * createEngine({ id, commodity, strategy, prefix, modeKey, label })
 *   id         file/URL slug, e.g. "cmx_gold_ema_rsi_st"
 *   commodity  "CRUDE" | "GOLD" | "SILVER" (see mcxContracts.COMMODITIES)
 *   strategy   "V1" | "V2"
 *   prefix     env prefix of the per-strategy commodity settings, e.g.
 *              "CMX_EMA_RSI_ST" — shared by that strategy's three commodities
 *   modeKey    this page's on/off toggle, e.g. "CMX_GOLD_EMA_RSI_ST_MODE_ENABLED"
 */
function createEngine({ id, commodity, strategy, prefix, modeKey, label }) {
  const A = ADAPTERS[strategy];
  const TRADES_FILE = path.join(DATA_DIR, `${id}_paper_trades.json`);
  const ACTIVE_FILE = path.join(DATA_DIR, `.active_${id}_position.json`);
  const RUN_FILE    = path.join(DATA_DIR, `.running_${id}.json`);
  const TAG = `[${id.toUpperCase()}-PAPER]`;
  const modeOn = () => String(process.env[modeKey] || A.modeDefault || "false").toLowerCase() === "true";

  // ── live config ─────────────────────────────────────────────────────────────
  const cfg = () => ({
    // Candle size is fixed for a running session — a mid-session change would mix
    // candle lengths in one series. It applies on the next Start.
    res:        state.res || Math.max(1, _int(process.env[`${prefix}_RESOLUTION`], A.defaultRes || 5)),
    lots:       Math.max(1, _int(process.env[`${prefix}_LOTS`], 1)),
    entryStart: _mins(process.env[`${prefix}_ENTRY_START`], "10:00"),
    entryEnd:   _mins(process.env[`${prefix}_ENTRY_END`], "22:30"),
    eodExit:    _mins(process.env[`${prefix}_EOD_EXIT_TIME`], "23:00"),
    maxTrades:  Math.max(1, _int(process.env[`${prefix}_MAX_DAILY_TRADES`], 3)),
    // Tighter of the per-strategy and per-commodity caps (0 = that cap off).
    maxLoss:    _tighterCap(
      Math.max(0, _num(process.env[`${prefix}_MAX_DAILY_LOSS`], 5000)),
      Math.max(0, _num(process.env[`CMX_${commodity}_MAX_DAILY_LOSS`], CMX_MAX_LOSS_DEFAULT[commodity] || 0))),
    optStopPct: Math.max(0, _num(process.env.CMX_OPT_STOP_PCT, 10)),
    rollDays:   Math.max(0, _int(process.env.CMX_OPT_ROLL_DAYS, 2)),
    sessStart:  _mins(process.env.CMX_SESSION_START, "09:00"),
    sessEnd:    _mins(process.env.CMX_SESSION_END, "23:30"),
    charges:    Math.max(0, _num(process.env.CMX_CHARGES_PER_TRADE, 60)),
    confirm:    A.noConfirm ? false : confirmCandle.enabled(A.rulesKey),
    startCap:   Math.max(0, _num(process.env.FYERS_INV_AMOUNT, 100000)),   // the shared Fyers pool
    minGapPct:  Math.max(0, _num(process.env.CMX_MIN_EMA_GAP_PCT, 0.03)),
    rsiCeMax:   _num(process.env.CMX_RSI_CE_MAX, 63),
    rsiPeMin:   _num(process.env.CMX_RSI_PE_MIN, 37),
  });

  const state = {
    running: false, starting: false, res: null, day: null, series: null, candles: [], lastBarTime: null,
    futLtp: null, optLtp: null, lastQuoteAt: null, nextCandleAt: 0, formingBar: null,
    position: null, armed: null, trades: [], sessionPnl: 0,
    consecLosses: 0, halted: null, slPauseUntil: { CE: 0, PE: 0 }, oppCooldown: null,
    lastSignal: null, lastError: null, logs: [], seenQuoteAt: 0, manualStopDay: null,
    pivots: null, pivotsError: null, pivotsTryAt: 0, lastChecks: null,   // PIVOT adapter only
  };
  let timer = null, busy = false, lastErrLogAt = 0;

  function log(msg) {
    const line = `${istClock()} ${msg}`;
    state.logs.push(line);
    if (state.logs.length > LOG_MAX) state.logs.shift();
    console.log(`${TAG} ${msg}`);
  }
  function noteError(msg) {
    state.lastError = msg;
    if (Date.now() - lastErrLogAt > 60000) { lastErrLogAt = Date.now(); log(`⚠️ ${msg}`); }
  }

  // ── files ─────────────────────────────────────────────────────────────────
  function _readJson(f, def) { try { return JSON.parse(fs.readFileSync(f, "utf-8")); } catch (_) { return def; } }
  function _writeJson(f, v) {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = f + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(v, null, 2));
      fs.renameSync(tmp, f);
    } catch (err) { console.warn(`${TAG} save failed: ${err.message}`); }
  }
  function loadBook() { return _readJson(TRADES_FILE, { days: {} }); }
  function saveDayTrades() {
    const book = loadBook();
    book.days = book.days || {};
    book.days[state.day] = { trades: state.trades, pnl: r2(state.sessionPnl) };
    _writeJson(TRADES_FILE, book);
  }
  function persistPosition() {
    if (state.position) _writeJson(ACTIVE_FILE, { day: state.day, position: state.position });
    else { try { fs.unlinkSync(ACTIVE_FILE); } catch (_) {} }
  }
  function persistRunning() {
    if (state.running) _writeJson(RUN_FILE, { day: state.day });
    else { try { fs.unlinkSync(RUN_FILE); } catch (_) {} }
  }

  // New IST day → fresh counters, today's trades reloaded from disk.
  function rollDay() {
    const d = istDay();
    if (state.day === d) return;
    state.day = d;
    const today = loadBook().days?.[d];
    state.trades = today ? today.trades : [];
    state.sessionPnl = r2(state.trades.reduce((s, t) => s + (t.pnl || 0), 0));
    state.consecLosses = 0;
    for (let i = state.trades.length - 1; i >= 0 && state.trades[i].pnl < 0; i--) state.consecLosses++;
    state.halted = null; state.slPauseUntil = { CE: 0, PE: 0 }; state.oppCooldown = null; state.armed = null;
    state._reentryBlockUntil = 0;
  }

  // ── broker reads ────────────────────────────────────────────────────────────
  async function fetchCandles(symbol, res, fromDay, toDay) {
    const r = await sharedHistory({ symbol, resolution: String(res), date_format: "1", range_from: fromDay, range_to: toDay, cont_flag: "1" });
    if (r.s !== "ok" && r.s !== "no_data") throw new Error(`history ${symbol}: ${r.message || r.s}`);
    const nowSec = Math.floor(Date.now() / 1000);
    return (r.candles || [])
      .map(([time, open, high, low, close, volume]) => ({ time, open, high, low, close, volume }))
      .filter((c) => c.time + res * 60 <= nowSec - 1);          // closed bars only
  }
  // ── PIVOT adapter only: the previous MCX day's floor pivots ────────────────
  // Fyers stamps every "D" bar at 00:00 IST of its trading date (see the note in
  // services/backtestEngine.fetchCandles), and an MCX session (09:00–23:30/23:55)
  // never crosses midnight — so the series is one bar per IST day, which is what
  // computePivots requires (it refuses two bars on one day). It takes the newest
  // bar strictly BEFORE today, so today's forming daily bar can never move R1/S1.
  // Same future the engine trades. Fetched at Start and whenever the IST day no
  // longer matches; on failure retried at most once a minute, and getSignal
  // refuses every entry meanwhile (its reason is logged on each candle).
  const PIVOT_RETRY_MS = 60000;
  let pivotsBusy = false;
  const todayKey = () => Math.floor((Math.floor(Date.now() / 1000) + 19800) / 86400);
  async function refreshPivots() {
    if (!A.needsPivots || pivotsBusy || !state.series) return;
    pivotsBusy = true;
    state.pivotsTryAt = Date.now();
    const forDayKey = todayKey();
    try {
      const r = await sharedHistory({ symbol: state.series.future, resolution: "D", date_format: "1",
        range_from: istDay(Date.now() - 15 * 86400000), range_to: istDay(), cont_flag: "1" });
      if (r.s !== "ok" && r.s !== "no_data") throw new Error(`daily history ${state.series.future}: ${r.message || r.s}`);
      const daily = (r.candles || []).map(([time, open, high, low, close]) => ({ time, open, high, low, close }));
      const pv = require("../strategies/pivot_ema_st").computePivots(daily, { forDayKey });
      if (pv && pv.forDayKey === forDayKey) {
        state.pivots = pv; state.pivotsError = null;
        log(`📐 Pivots (prev day ${pv.from}, ${state.series.future}): PP ${pv.pp} | R1 ${pv.r1} | S1 ${pv.s1}`);
      } else {
        state.pivots = null;
        state.pivotsError = daily.length ? "previous day's daily bar unusable — no R1/S1" : "no daily candles returned — no R1/S1";
        log(`⚠️ ${state.pivotsError} (${daily.length} daily bars). No entries until the pivots load — retry in ${PIVOT_RETRY_MS / 1000}s.`);
      }
    } catch (err) {
      state.pivots = null;
      state.pivotsError = `pivot fetch failed: ${err.message}`;
      log(`⚠️ ${state.pivotsError} — no entries until R1/S1 load (retry in ${PIVOT_RETRY_MS / 1000}s).`);
    } finally { pivotsBusy = false; }
  }
  /** Background, throttled: keep state.pivots on today's IST day. */
  function ensurePivots() {
    if (!A.needsPivots) return;
    if (state.pivots && state.pivots.forDayKey === todayKey()) return;
    if (state.pivots) { state.pivots = null; state.pivotsError = "pivots belong to another day — refreshing"; }
    if (Date.now() - (state.pivotsTryAt || 0) < PIVOT_RETRY_MS) return;
    refreshPivots().catch(() => {});
  }
  /**
   * PIVOT adapter only: getSignal refused the pivots as "stale_pivots" (older
   * than the last session in the candle buffer). Drop them so ensurePivots()
   * on the next loop re-fetches — still at most once a minute (pivotsTryAt).
   * Without this the forDayKey match would keep the stale levels all day.
   */
  let stalePivotsLogged = null;
  function dropStalePivots(reason) {
    state.pivots = null;
    state.pivotsError = `stale pivots — ${reason || "older than the last session"} · re-fetching`;
    if (stalePivotsLogged !== reason) {
      stalePivotsLogged = reason;
      log(`⚠️ ${reason || "stale pivots"} — dropped; re-fetching (at most once every ${PIVOT_RETRY_MS / 1000}s). No entries until fresh R1/S1 load.`);
    }
  }

  async function quotes(symbols) {
    const r = await fyers.getQuotes(symbols.filter(Boolean));
    if (r.s !== "ok") throw new Error(`quotes: ${r.message || r.s}`);
    const out = {};
    for (const d of r.d || []) {
      const v = d.v || {};
      if (Number.isFinite(v.lp) && v.lp > 0) out[d.n || v.symbol] = v.lp;
    }
    return out;
  }

  // ── guards ─────────────────────────────────────────────────────────────────
  function entryBlock(side) {
    const c = cfg();
    if (state.halted) return state.halted;
    if (state.trades.length >= c.maxTrades) return `max ${c.maxTrades} trades/day reached`;
    if (c.maxLoss > 0 && state.sessionPnl <= -c.maxLoss) { state.halted = `daily loss ₹${c.maxLoss} reached — done for today`; return state.halted; }
    const lim = A.consecLimit();
    if (lim > 0 && state.consecLosses >= lim) { state.halted = `${state.consecLosses} losses in a row — done for today`; return state.halted; }
    if (state.slPauseUntil[side] > Date.now()) return `${side} paused after a stop-out`;
    const oc = state.oppCooldown;
    if (oc && oc.side !== side && oc.until > Date.now()) return `opposite-side cooldown after ${oc.side} exit`;
    return null;
  }
  // Trend filter — refuses the two kinds of signal that lost most on MCX
  // (Oct 2026 paper, 111 trades): EMA20 and EMA50 almost touching, i.e. no
  // real trend (27 trades, 4 wins, −₹17.9k), and an RSI that has already run
  // (crude: 13 trades, 1 win, −₹15.7k). Read off the signal candle; entry only,
  // so an opposite signal still exits an open trade.
  function trendBlock(side, sig, price) {
    const c = cfg();
    if (c.minGapPct > 0) {
      if (!Number.isFinite(sig.ema20) || !Number.isFinite(sig.ema50) || !(price > 0)) return "trend filter — EMA value missing";
      const gapPct = Math.abs(sig.ema20 - sig.ema50) / price * 100;
      if (gapPct < c.minGapPct) return `EMA20/EMA50 too close (gap ${gapPct.toFixed(3)}% < ${c.minGapPct}%) — no real trend`;
    }
    const rsiCapOn = side === "CE" ? c.rsiCeMax < 100 : c.rsiPeMin > 0;
    if (rsiCapOn) {
      if (!Number.isFinite(sig.rsi)) return "trend filter — RSI value missing";
      if (side === "CE" && sig.rsi >= c.rsiCeMax) return `RSI ${r2(sig.rsi)} ≥ ${c.rsiCeMax} — move already run`;
      if (side === "PE" && sig.rsi <= c.rsiPeMin) return `RSI ${r2(sig.rsi)} ≤ ${c.rsiPeMin} — move already run`;
    }
    return null;
  }
  function inEntryWindow(barTimeSec) {
    const c = cfg(), m = istMinutesOf(barTimeSec);
    return m >= c.entryStart && m < c.entryEnd;
  }

  // ── entry / exit ───────────────────────────────────────────────────────────
  async function enter(side, spot, sig, beforeTime, entryBarTime, how) {
    const c = cfg();
    const block = entryBlock(side);
    if (block) { log(`⏸️ ${side} skipped — ${block}`); return; }
    // Global wait-after-any-exit cooldown (EXIT_REENTRY_COOLDOWN_CANDLES). Manual
    // entries are the user's own call and bypass it. Logged once per cooldown.
    if (how !== "manual entry" && state._reentryBlockUntil > Date.now()) {
      if (state._reentryBlockLogged !== state._reentryBlockUntil) {
        state._reentryBlockLogged = state._reentryBlockUntil;
        log(`⏸️ ${side} skipped — wait-after-exit cooldown, no new entry until ~${istClock(state._reentryBlockUntil)}`);
      }
      return;
    }
    if (istNowMinutes() >= c.eodExit) { log(`⏸️ ${side} skipped — past the ${fmtMins(c.eodExit)} exit time`); return; }
    const opt = mcx.atmOption(state.series, side, spot);
    if (!opt) { log(`❌ ${side} skipped — no listed ${side} strike near ${spot}`); return; }

    const seed = A.seedStop(side, spot, sig);
    const fix = tradeGuards.resolveProtectiveStop({ side, entryPrice: spot, stopLoss: seed, candles: state.candles, beforeTime });
    if (seed != null && fix.stopLoss == null) { log(`🚫 ${side} skipped — ${fix.reason}`); return; }
    if (fix.repaired) log(`🛡️ Initial SL corrected — ${fix.reason}`);

    let premium = null;
    try { premium = (await quotes([opt.symbol]))[opt.symbol] || null; } catch (err) { noteError(err.message); }
    if (!premium) { log(`❌ ${side} skipped — no price for ${opt.symbol}`); return; }
    if (state.position || !state.running) return;   // a parallel path got there first, or Stop was pressed

    // The session's contract decides the size — not a Settings change made since Start.
    const u = mcx.underlyingInfo(state.series.underlying);
    const cost = premium * u.multiplier * c.lots;
    const cap = capitalPool.gate(id, cost, { side, symbol: opt.symbol, qty: u.multiplier * c.lots });
    if (!cap.ok) { if (!cap.muted) log(`❌ ${side} skipped — ${cap.reason}`); return; }
    state.position = {
      side, symbol: opt.symbol, strike: opt.strike, expiry: opt.expiry,
      lots: c.lots, multiplier: u.multiplier,
      spotAtEntry: spot, stopLoss: fix.stopLoss, initialStopLoss: fix.stopLoss,
      optionEntryLtp: premium, bestOptionLtp: premium, bestPrice: spot,
      entryTime: new Date().toISOString(), entryBarTime, candlesHeld: 0,
      // For the first-move/path log: ±0.015% of the future, the same share of
      // price as NIFTY's 3 pts (Gold ~₹1.2L → ~18 pts, Crude ~₹5.5k → ~1 pt).
      entryTimeMs: Date.now(), firstMovePts: Math.max(1, r2(spot * 0.00015)),
      reason: `${how} | ${sig.reason || ""}`.slice(0, 300),
      rsi: sig.rsi ?? null, ema20: sig.ema20 ?? null, ema50: sig.ema50 ?? null, supertrend: sig.supertrend ?? null,
      // PIVOT adapter only: its signal names the EMAs emaFast/emaSlow (no RSI) and
      // carries the cross level + zone. V1/V2 spread nothing — their record is unchanged.
      ...(A.needsPivots ? { ema20: sig.emaFast ?? null, ema50: sig.emaSlow ?? null, crossLevel: sig.crossLevel ?? null, zone: sig.zone ?? null } : {}),
    };
    state.optLtp = premium;
    state.armed = null;
    capitalPool.block(id, cost, { side, symbol: opt.symbol, qty: u.multiplier * c.lots, premium });
    persistPosition();
    hubNeed(id, [state.series.future, opt.symbol], true);
    log(`✅ BUY ${side} ${opt.symbol} @ ₹${premium} × ${c.lots} lot (${u.multiplier * c.lots} units) | fut ${spot} | SL ${fix.stopLoss} | ${how}`);
    if (modeOn()) tg("TG_CMX_ENTRY", [
      `🛢 ${label} PAPER — ENTRY`, ``,
      side === "CE" ? "📈 CALL (CE)" : "📉 PUT (PE)",
      `Symbol : ${opt.symbol}`,
      `Strike: ${opt.strike}  |  Expiry: ${opt.expiry || "—"}`, ``,
      `Future @ Entry : ₹${spot}`,
      `Option Premium : ₹${premium}`,
      `Stop Loss      : ${fix.stopLoss != null ? "₹" + fix.stopLoss : "—"}`,
      `Qty / Lots     : ${u.multiplier * c.lots} (${c.lots} lot)`, ``,
      `Reason : ${state.position.reason || "—"}`,
    ]);
  }

  async function exit(reason, spotExit, { slHit = false } = {}) {
    const pos = state.position;
    if (!pos) return;
    let prem = state.optLtp;
    try { const q = await quotes([pos.symbol]); if (q[pos.symbol]) prem = q[pos.symbol]; } catch (err) { noteError(err.message); }
    if (state.position !== pos) return;
    prem = prem || pos.optionEntryLtp;
    const c = cfg();
    const gross = r2((prem - pos.optionEntryLtp) * pos.multiplier * pos.lots);
    const pnl = r2(gross - c.charges);
    const trade = {
      ...pos, exitTime: new Date().toISOString(), exitReason: reason,
      exitBarTime: Math.floor(Date.now() / 1000 / (c.res * 60)) * c.res * 60,
      spotAtExit: spotExit, optionExitLtp: prem, grossPnl: gross, charges: c.charges, pnl,
    };
    state.trades.push(trade);
    state.sessionPnl = r2(state.sessionPnl + pnl);
    state.consecLosses = pnl < 0 ? state.consecLosses + 1 : 0;
    state.position = null;
    persistPosition();
    saveDayTrades();
    // The day book already holds this P&L, so only the reservation is freed.
    capitalPool.release(id);

    const resMs = c.res * 60000;
    if (slHit && A.slPauseCandles() > 0) state.slPauseUntil[pos.side] = Date.now() + A.slPauseCandles() * resMs;
    if (A.oppCooldownOn() && A.oppCooldownCandles() > 0
        && !/opposite signal|eod|day close|market closed|auto-stop|manual|session/i.test(reason)) {
      state.oppCooldown = { side: pos.side, until: Date.now() + A.oppCooldownCandles() * resMs };
    }
    // Global wait-after-any-exit cooldown — no entry on either side for N candles.
    state._reentryBlockUntil = tradeGuards.reentryCooldownUntil(Date.now(), c.res);
    log(`${pnl >= 0 ? "💰" : "🔻"} EXIT ${pos.side} ${pos.symbol} @ ₹${prem} | ${reason} | P&L ₹${pnl} (gross ₹${gross}) | day ₹${state.sessionPnl}`);
    log(`   Trade detail: fut ${pos.spotAtEntry} → ${spotExit} | premium ₹${pos.optionEntryLtp} → ₹${prem} (best ₹${pos.bestOptionLtp}) | MFE=${r2(pos.mfe || 0)} MAE=${r2(pos.mae || 0)} | held ${pos.candlesHeld} candles | SL ${pos.initialStopLoss} → ${pos.stopLoss} | lock ${pos.lockArmedAt ? "armed" : "never armed"}`);
    if (modeOn()) tg("TG_CMX_EXIT", [
      `🛢 ${label} PAPER — EXIT`, ``,
      pos.side === "CE" ? "📈 CALL (CE)" : "📉 PUT (PE)",
      `Symbol : ${pos.symbol}`, ``,
      `Future @ Entry : ₹${pos.spotAtEntry}`,
      `Future @ Exit  : ₹${spotExit}`,
      `Premium @ Entry: ₹${pos.optionEntryLtp}`,
      `Premium @ Exit : ₹${prem}`, ``,
      `PnL (net)      : ₹${pnl}  ${pnl >= 0 ? "🟢" : "🔴"}`,
      `Day PnL        : ₹${state.sessionPnl}`, ``,
      `Exit Reason    : ${reason}`,
    ]);
  }

  // ── candle close ───────────────────────────────────────────────────────────
  async function onBarClose(bar) {
    state.candles.push(bar);
    if (state.candles.length > MAX_CANDLES) state.candles.shift();
    state.lastBarTime = bar.time;
    const c = cfg();
    const sig = A.signal(state.candles, { pivots: state.pivots, res: c.res }) || {};   // V1/V2 ignore the 2nd argument
    if (A.needsPivots && sig.skipReason === "stale_pivots") dropStalePivots(sig.reason);   // PIVOT adapter only
    const winOk = inEntryWindow(bar.time);
    state.lastSignal = { at: bar.time, signal: sig.signal, reason: winOk ? sig.reason : `outside entry window (${sig.reason || ""})`, close: bar.close };
    if (A.needsPivots) state.lastChecks = sig.checks && sig.checks.ready ? sig.checks : null;

    if (state.armed && state.armed.armedBarTime !== bar.time) state.armed = null;   // confirm window passed
    logCandle(bar, sig, winOk);

    const pos = state.position;
    if (pos) {
      pos.candlesHeld++;
      const why = A.onClose({ state, log }, pos, bar, sig);
      persistPosition();
      if (why) { await exit(why, bar.close); }
      else if (winOk && sig.signal === (pos.side === "CE" ? "BUY_PE" : "BUY_CE")) { await exit("Opposite signal exit", bar.close); }
    }
    if (state.position && istNowMinutes() >= c.eodExit) {
      await exit(`Exit before day close ${fmtMins(c.eodExit)}`, bar.close);
      return;
    }

    if (!state.position && winOk && (sig.signal === "BUY_CE" || sig.signal === "BUY_PE")) {
      const side = sig.signal === "BUY_CE" ? "CE" : "PE";
      const block = entryBlock(side);
      if (block) { log(`⏸️ ${sig.signal} on ${bar.close} — skipped: ${block}`); return; }
      const weak = A.noTrendFilter ? null : trendBlock(side, sig, bar.close);
      if (weak) { log(`🚫 ${sig.signal} on ${bar.close} — skipped: ${weak}`); return; }
      if (c.confirm) {
        state.armed = { side, triggerLevel: bar.close, armedBarTime: bar.time, sig };
        hubNeed(id, [state.series.future], true);
        hubUrgent();
        log(`🎯 ${sig.signal} signal candle closed — ARMED; next candle must cross ${bar.close} | ${sig.reason || ""}`);
      } else {
        await enter(side, bar.close, sig, bar.time + c.res * 60, bar.time + c.res * 60, "candle close");
      }
    }
  }

  // Profit-lock / breakeven state of an open position, for the logs.
  function lockStatus(pos) {
    const e = pos.optionEntryLtp, best = pos.bestOptionLtp;
    if (!e || !tradeGuards.PROFIT_LOCK_ENABLED) return "lock off";
    const armLtp = r2(e * (1 + tradeGuards.PROFIT_LOCK_ARM_PCT / 100));
    if (!best || best < armLtp) {
      const be = tradeGuards.BREAKEVEN_STOP_ENABLED
        && best >= e * (1 + tradeGuards.BREAKEVEN_ARM_PCT / 100) ? " | breakeven armed @ ₹" + e : "";
      return `lock not armed (arms at ₹${armLtp}, +${tradeGuards.PROFIT_LOCK_ARM_PCT}%)${be}`;
    }
    const floor = tradeGuards.profitLockFloorLtp(e, best, tradeGuards.PROFIT_LOCK_FLOOR_PCT, tradeGuards.PROFIT_LOCK_TRAIL_PCT);
    const kept = best > e ? Math.round((floor - e) / (best - e) * 100) : 0;
    return `lock ARMED — floor ₹${floor} (keeps ${kept}% of gain)`;
  }

  // One detailed block per candle close — what the engine saw and why it did
  // what it did, so a day can be analysed from the log alone.
  function logCandle(bar, sig, winOk) {
    const f = (v) => (Number.isFinite(v) ? r2(v) : "?");
    const resSec = cfg().res * 60;
    log(`📊 ──── Candle ${istClock(bar.time * 1000).slice(0, 5)}–${istClock((bar.time + resSec) * 1000).slice(0, 5)} closed ────`);
    log(`   OHLC: O=${bar.open} H=${bar.high} L=${bar.low} C=${bar.close} | body=${f(Math.abs(bar.close - bar.open))}`);
    log(A.candleLine ? A.candleLine(sig, f) : `   EMA20=${f(sig.ema20)} EMA50=${f(sig.ema50)} | RSI=${f(sig.rsi)} | ST=${f(sig.supertrend)}(${sig.stTrend || "?"})`);
    // Only where onBarClose would check it anyway — entryBlock can latch state.halted.
    const sigSide = sig.signal === "BUY_CE" ? "CE" : "PE";
    const blockNote = winOk && !state.position && (sig.signal === "BUY_CE" || sig.signal === "BUY_PE")
      ? (entryBlock(sigSide) || (A.noTrendFilter ? null : trendBlock(sigSide, sig, bar.close)) || "") : "";
    log(`   Signal: ${sig.signal || "NONE"}${winOk ? "" : " | outside entry window"}${blockNote ? " | blocked: " + blockNote : ""} | ${sig.reason || "—"}`);
    const pos = state.position;
    if (pos) {
      const dir = pos.side === "CE" ? 1 : -1;
      const gap = Number.isFinite(pos.stopLoss) ? f((bar.close - pos.stopLoss) * dir) : "?";
      log(`   Open ${pos.side} @ fut ${pos.spotAtEntry} | SL=${pos.stopLoss} (gap=${gap}) | best fut=${pos.bestPrice} | MFE=${f(pos.mfe || 0)} MAE=${f(pos.mae || 0)} | held ${pos.candlesHeld} candles`);
      if (state.optLtp) {
        const units = pos.multiplier * pos.lots;
        const d = r2(state.optLtp - pos.optionEntryLtp);
        log(`   Option: entry=₹${pos.optionEntryLtp} now=₹${state.optLtp} best=₹${pos.bestOptionLtp} (Δ₹${d} × ${units} = ₹${r2(d * units)} gross) | ${lockStatus(pos)}`);
      } else {
        log(`   Option: no live premium yet — profit lock cannot be checked`);
      }
    }
  }

  // ── per-poll price checks ──────────────────────────────────────────────────
  async function onPrice(fut) {
    const c = cfg();
    const nowSec = Math.floor(Date.now() / 1000);
    const bucket = Math.floor(nowSec / (c.res * 60)) * c.res * 60;

    const a = state.armed;
    if (a && !state.position) {
      if (confirmCandle.isNextBar(bucket, a.armedBarTime, c.res)) {
        if (confirmCandle.crossed(a.side, fut, a.triggerLevel)) {
          await enter(a.side, fut, a.sig, bucket, bucket, `confirmed cross of ${a.triggerLevel}`);
        }
      } else if (bucket > a.armedBarTime + c.res * 60) {
        log(`⌛ Armed ${a.side} expired — next candle never crossed ${a.triggerLevel}`);
        state.armed = null;
      }
    }

    const pos = state.position;
    if (!pos) return;
    const fav = (fut - pos.spotAtEntry) * (pos.side === "CE" ? 1 : -1);
    pos.mfe = Math.max(pos.mfe || 0, r2(fav));
    pos.mae = Math.min(pos.mae || 0, r2(fav));
    trackPath(pos, fav, Date.now());
    if (state.optLtp && state.optLtp > (pos.bestOptionLtp || 0)) pos.bestOptionLtp = state.optLtp;
    if (pos.side === "CE" ? fut > pos.bestPrice : fut < pos.bestPrice) pos.bestPrice = fut;
    if (!pos.lockArmedAt && tradeGuards.PROFIT_LOCK_ENABLED && pos.optionEntryLtp
        && pos.bestOptionLtp >= pos.optionEntryLtp * (1 + tradeGuards.PROFIT_LOCK_ARM_PCT / 100)) {
      pos.lockArmedAt = new Date().toISOString();
      log(`🔒 Profit lock ARMED — premium ₹${pos.bestOptionLtp} ≥ +${tradeGuards.PROFIT_LOCK_ARM_PCT}% of entry ₹${pos.optionEntryLtp} | ${lockStatus(pos)}`);
    }

    if (state.optLtp) {
      const lock = tradeGuards.checkProfitLock(pos.optionEntryLtp, state.optLtp, pos.bestOptionLtp)
        || tradeGuards.checkBreakevenStop(pos.optionEntryLtp, state.optLtp, pos.bestOptionLtp);
      if (lock) { await exit(lock, fut); return; }
      const pct = cfg().optStopPct;
      if (pct > 0 && state.optLtp <= r2(pos.optionEntryLtp * (1 - pct / 100))) {
        await exit(`Option stop ${pct}% @ opt ₹${state.optLtp}`, fut, { slHit: true });
        return;
      }
    }
    // PIVOT_EMA_ST: the future stop is tested on candle close only (A.onClose), never per poll.
    if (!A.candleCloseStopOnly && Number.isFinite(pos.stopLoss) && (pos.side === "CE" ? fut <= pos.stopLoss : fut >= pos.stopLoss)) {
      const kind = Math.abs(pos.stopLoss - pos.initialStopLoss) > 0.01 ? "Trail" : "Initial";
      await exit(`${kind} SL hit @ ${pos.stopLoss}`, fut, { slHit: true });
    }
  }

  // ── main loop ──────────────────────────────────────────────────────────────
  async function loop() {
    if (busy || !state.running) return;
    busy = true;
    try {
      rollDay();
      ensurePivots();   // PIVOT adapter only (no-op for V1/V2)
      const c = cfg();
      const nowMin = istNowMinutes();

      if (nowMin >= c.sessEnd) { await stop(`market closed ${fmtMins(c.sessEnd)}`); return; }
      if (state.position && nowMin >= c.eodExit) await exit(`Exit before day close ${fmtMins(c.eodExit)}`, state.futLtp || state.position.spotAtEntry);

      // A bar is due once the one after the last closed bar has itself closed.
      const nowSec = Math.floor(Date.now() / 1000);
      const due = state.lastBarTime == null || nowSec >= state.lastBarTime + 2 * c.res * 60 + 2;
      if (due && Date.now() >= state.nextCandleAt) {
        try {
          const bars = (await fetchCandles(state.series.future, c.res, state.day, state.day))
            .filter((b) => state.lastBarTime == null || b.time > state.lastBarTime);
          if (bars.length) { for (const b of bars) await onBarClose(b); state.lastError = null; }
          else {
            // Not published yet → retry soon; long past due (holiday, halt) → back off.
            const lateBy = state.lastBarTime == null ? 0 : nowSec - (state.lastBarTime + 2 * c.res * 60);
            state.nextCandleAt = Date.now() + (lateBy > 60 ? 60000 : 10000);
          }
        } catch (err) { noteError(err.message); state.nextCandleAt = Date.now() + 15000; }
      }

      // Live price from the shared hub: fast while a trade or armed signal needs
      // it, slow otherwise (display only). Act once per fresh future quote.
      hubNeed(id, [state.series.future, state.position && state.position.symbol], !!(state.position || state.armed));
      const fq = hub.last[state.series.future];
      if (state.position) { const oq = hub.last[state.position.symbol]; if (oq) state.optLtp = oq.lp; }
      if (fq && fq.at > state.seenQuoteAt) {
        state.seenQuoteAt = fq.at;
        state.futLtp = fq.lp; state.lastQuoteAt = fq.at;
        // The candle still forming, from the live quotes — display only.
        const bucket = Math.floor(fq.at / 1000 / (c.res * 60)) * c.res * 60;
        const fb = state.formingBar;
        if (!fb || fb.time !== bucket) state.formingBar = { time: bucket, open: fq.lp, high: fq.lp, low: fq.lp, close: fq.lp };
        else { fb.high = Math.max(fb.high, fq.lp); fb.low = Math.min(fb.low, fq.lp); fb.close = fq.lp; }
        if (nowMin >= c.sessStart) await onPrice(state.futLtp);
      } else if (hub.lastErr) noteError(hub.lastErr);
    } catch (err) {
      noteError(`loop error: ${err.message}`);
    } finally { busy = false; }
  }

  // ── start / stop / reset ───────────────────────────────────────────────────
  async function start(opts) {
    if (state.running || state.starting) return { ok: false, reason: "already running" };
    state.starting = true;
    try { return await _start(opts); } finally { state.starting = false; }
  }
  async function _start({ resumed = false } = {}) {
    state.res = null;
    const c = cfg();
    const dow = istDow();
    if (dow === 0 || dow === 6) return { ok: false, reason: "MCX is closed on Saturday and Sunday" };
    if (istNowMinutes() >= c.sessEnd) return { ok: false, reason: `MCX session is over for today (closes ${fmtMins(c.sessEnd)})` };

    rollDay();
    try { state.series = await mcx.resolveSeries(mcx.contractFor(commodity), { rollDays: c.rollDays }); }
    catch (err) { return { ok: false, reason: `could not pick the contract: ${err.message}` }; }

    // Warm-up: ~7 calendar days of closed candles on the signal future.
    try {
      const from = istDay(Date.now() - 7 * 86400000);
      state.candles = (await fetchCandles(state.series.future, c.res, from, state.day)).slice(-MAX_CANDLES);
    } catch (err) { return { ok: false, reason: `could not load candles (is the Fyers login fresh?): ${err.message}` }; }
    state.lastBarTime = state.candles.length ? state.candles[state.candles.length - 1].time : null;
    // PIVOT: the levels before the first candle is judged. A failure does not
    // block Start — entries are refused until a retry (once a minute) succeeds.
    if (A.needsPivots) { state.pivots = null; state.pivotsTryAt = 0; state.lastChecks = null; await refreshPivots(); }

    // MCX holiday gate — weekday closures (full day, or the morning of an
    // evening-only day). No calendar: if well past the latest session open the
    // future has printed no bar and its quote shows no trade since that open,
    // the session is not running. Any sign of activity vetoes it (see mcxHolidays).
    // Fails OPEN: "closed" needs a quote that actually came back with an exchange
    // trade time older than the open — missing/failed data never blocks a start.
    // Skipped when a same-day position is saved, so a restart can't orphan it.
    const gate = { nowMs: Date.now(), sessStartMin: c.sessStart, sessEndMin: c.sessEnd, resMin: c.res, lastBarTimeSec: state.lastBarTime };
    const savedPeek = _readJson(ACTIVE_FILE, null);
    const hasSavedToday = !!(savedPeek && savedPeek.position && savedPeek.day === state.day);
    if (!hasSavedToday && mcxHolidays.mcxSessionClosed(gate).closed) {
      try {
        const r = await fyers.getQuotes([state.series.future]);
        const d = r && r.s === "ok" && (r.d || [])[0];
        gate.quoteTradeSec = mcxHolidays.quoteTradeSec(d && d.v);
      } catch (_) { /* no quote → treated as open below */ }
      const shut = Number.isFinite(gate.quoteTradeSec) ? mcxHolidays.mcxSessionClosed(gate) : { closed: false };
      if (shut.closed) {
        closedUntil = shut.untilMs;
        return { ok: false, reason: `MCX looks closed today — no trade in ${state.series.future} since ${fmtMins(shut.openMin)}; not polling until ${istDay(shut.untilMs)} ${istClock(shut.untilMs).slice(0, 5)} IST` };
      }
    }
    closedUntil = 0;

    // Same-day open position from before a restart — carry on managing it.
    const saved = _readJson(ACTIVE_FILE, null);
    if (saved && saved.position) {
      if (saved.day === state.day) {
        state.position = saved.position;
        const p = saved.position;
        capitalPool.block(id, (p.optionEntryLtp || 0) * (p.multiplier || 0) * (p.lots || 0), { side: p.side, symbol: p.symbol, premium: p.optionEntryLtp });
        log(`♻️ Restored open ${p.side} ${p.symbol} from before restart`);
      }
      else { log(`🧹 Dropped a stale saved position from ${saved.day}`); try { fs.unlinkSync(ACTIVE_FILE); } catch (_) {} }
    }

    state.running = true;
    state.res = c.res;
    state.armed = null; state.nextCandleAt = 0; state.lastError = null; state.seenQuoteAt = 0;
    state.manualStopDay = null;
    state.startedAt = new Date().toISOString();
    persistRunning();
    log(`▶️ ${resumed ? "Resumed" : "Started"} ${label} — signal ${state.series.future} (${c.res}m, ${state.candles.length} warm-up candles) · options expire ${state.series.optionExpiry} · entries ${fmtMins(c.entryStart)}–${fmtMins(c.entryEnd)} · exit ${fmtMins(c.eodExit)}`);
    timer = setInterval(loop, 1000);
    if (modeOn()) tg("TG_CMX_STARTED", [
      `🛢 ${label} PAPER — ${resumed ? "RESUMED" : "STARTED"}`, ``,
      `Signal  : ${state.series.future} (${c.res}m)`,
      `Options : expire ${state.series.optionExpiry}`,
      `Entries : ${fmtMins(c.entryStart)} → ${fmtMins(c.entryEnd)} IST · exit ${fmtMins(c.eodExit)}`,
      `Max Loss: ₹${c.maxLoss} | Max Trades: ${c.maxTrades} | Lots: ${c.lots}`,
      state.position ? `Open    : ${state.position.side} ${state.position.symbol} (restored)` : null,
    ]);
    return { ok: true };
  }

  async function stop(reason = "manual stop") {
    if (!state.running) return;
    if (state.position) await exit(`Session ${reason}`, state.futLtp || state.position.spotAtEntry);
    state.running = false;
    state.res = null;
    state.armed = null;
    if (timer) { clearInterval(timer); timer = null; }
    hubNeed(id, null);
    if (/manual/i.test(reason)) state.manualStopDay = istDay();   // auto-start leaves it alone today
    persistRunning();
    log(`⏹️ Stopped — ${reason} | day P&L ₹${state.sessionPnl} over ${state.trades.length} trade(s)`);
    const wins = state.trades.filter((t) => t.pnl > 0).length;
    tg("TG_CMX_DAYREPORT", [
      `🛢 ${label} PAPER — STOPPED`, ``,
      `Reason : ${reason}`,
      `Trades : ${state.trades.length}  (W ${wins} / L ${state.trades.length - wins})`,
      `Day PnL: ₹${state.sessionPnl}  ${state.sessionPnl >= 0 ? "🟢" : "🔴"}`,
    ]);
  }

  function reset() {
    if (state.running) return { ok: false, reason: "stop the session first" };
    try { fs.unlinkSync(TRADES_FILE); } catch (_) {}
    try { fs.unlinkSync(ACTIVE_FILE); } catch (_) {}
    state.day = null; state.trades = []; state.sessionPnl = 0; state.logs = [];
    log("↺ History wiped");
    return { ok: true };
  }

  // One recorded day off the book — the History page's Delete Session. Today's
  // day is refused while running: the next exit would write it straight back.
  function deleteDay(day) {
    if (state.running && day === state.day) return { ok: false, reason: "stop the session before deleting today" };
    const book = loadBook();
    if (!book.days || !book.days[day]) return { ok: false, reason: `no session on ${day}` };
    delete book.days[day];
    _writeJson(TRADES_FILE, book);
    if (day === state.day) { state.day = null; rollDay(); }
    log(`🗑 Deleted the ${day} session`);
    return { ok: true };
  }

  function snapshot() {
    rollDay();
    const c = cfg();
    const book = loadBook();
    const days = Object.entries(book.days || {}).sort((a, b) => b[0].localeCompare(a[0]));
    const allTime = r2(days.reduce((s, [, d]) => s + (d.pnl || 0), 0));
    return {
      id, label, prefix, strategy, rulesKey: A.rulesKey, cfg: c,
      underlying: mcx.underlyingInfo(state.running && state.series ? state.series.underlying : mcx.contractFor(commodity)),
      commodity, commodityLabel: mcx.COMMODITIES[commodity].label, modeKey,
      running: state.running, series: state.series ? { future: state.series.future, futureExpiry: state.series.futureExpiry, optionExpiry: state.series.optionExpiry } : null,
      futLtp: state.futLtp, optLtp: state.optLtp, lastQuoteAt: state.lastQuoteAt,
      position: state.position, armed: state.armed ? { side: state.armed.side, triggerLevel: state.armed.triggerLevel } : null,
      trades: state.trades, sessionPnl: state.sessionPnl, halted: state.halted,
      lastSignal: state.lastSignal, lastError: state.lastError, candles: state.candles.length,
      prevBar: state.candles.length ? state.candles[state.candles.length - 1] : null,
      formingBar: state.running ? state.formingBar : null,
      consecLosses: state.consecLosses, consecLimit: A.consecLimit(), startedAt: state.startedAt || null,
      logs: state.logs.slice(-300), logTotal: state.logs.length, history: days.slice(0, 60).map(([day, d]) => ({ day, trades: (d.trades || []).length, pnl: d.pnl })),
      allTime,
      // PIVOT adapter only — spreads nothing for V1/V2.
      ...(A.needsPivots ? { pivots: state.pivots, pivotsError: state.pivotsError, checks: state.lastChecks } : {}),
    };
  }

  function manualExit() { if (state.position) return exit("Manual exit", state.futLtp || state.position.spotAtEntry); }

  // Manual CE / PE — a paper entry at the current future price, same guards,
  // sizing and exits as a signal entry. The stop starts at the last closed
  // candle's low (CE) / high (PE); the strategy's own trail takes over after.
  async function manualEntry(side) {
    if (side !== "CE" && side !== "PE") return { ok: false, reason: "side must be CE or PE" };
    if (!state.running) return { ok: false, reason: "start the page first" };
    if (state.position) return { ok: false, reason: "a trade is already open" };
    if (!state.futLtp) return { ok: false, reason: "no live price yet — wait a few seconds" };
    const c = cfg();
    const nowSec = Math.floor(Date.now() / 1000);
    const bucket = Math.floor(nowSec / (c.res * 60)) * c.res * 60;
    const last = state.candles[state.candles.length - 1];
    const seed = last ? (side === "CE" ? last.low : last.high) : null;
    await enter(side, state.futLtp, { stopLoss: seed }, bucket, bucket, "manual entry");
    return state.position ? { ok: true } : { ok: false, reason: "not entered — see the activity log" };
  }

  // Chart feed: today's closed candles (plus warm-up for the indicators), the
  // strategy's overlays and the day's entry/exit markers.
  function chartData() {
    const { EMA, RSI } = require("technicalindicators");
    const { computeSuperTrend } = require("../utils/supertrend");
    const k = A.chartCfg();
    const candles = state.candles.map((b) => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close }));
    const closes = candles.map((b) => b.close);
    const line = (arr) => arr.map((v, i) => ({ time: candles[i + candles.length - arr.length].time, value: r2(v) }));
    const ema = (p) => (candles.length >= p ? line(EMA.calculate({ period: p, values: closes })) : []);
    let supertrend = [];
    // PIVOT: plot engine.computeSeries — the exact numbers the signal read.
    const ser = A.chartSeries ? A.chartSeries(candles) : null;
    try {
      supertrend = (ser ? ser.supertrend : computeSuperTrend(candles, k.stPeriod, k.stMult))
        .map((p, i) => (p && p.value != null ? { time: candles[i].time, value: r2(p.value), trend: p.trend } : null)).filter(Boolean);
    } catch (_) {}
    const aligned = (arr) => (arr || []).map((v, i) => (Number.isFinite(v) ? { time: candles[i].time, value: r2(v) } : null)).filter(Boolean);
    const markers = [];
    for (const t of state.trades) {
      if (t.entryBarTime) markers.push({ time: t.entryBarTime, position: "belowBar", color: "#3b82f6", shape: "arrowUp", text: `${t.side} @ ${Math.round(t.spotAtEntry)}` });
      if (t.exitBarTime) markers.push({ time: t.exitBarTime, position: "aboveBar", color: t.pnl > 0 ? "#10b981" : "#ef4444", shape: "arrowDown", text: `Exit ${t.pnl > 0 ? "+" : ""}${Math.round(t.pnl)}` });
    }
    const p = state.position;
    if (p && p.entryBarTime) markers.push({ time: p.entryBarTime, position: "belowBar", color: "#3b82f6", shape: "arrowUp", text: `${p.side} @ ${Math.round(p.spotAtEntry)}` });
    if (ser) {
      const pv = state.pivots;
      return {
        candles, emaFast: aligned(ser.emaFast), emaSlow: aligned(ser.emaSlow), emaFastLen: k.emaFast, emaSlowLen: k.emaSlow,
        rsi: [], rsiCeMin: null, rsiPeMax: null, supertrend, markers,
        stopLoss: p && Number.isFinite(p.stopLoss) ? p.stopLoss : null, entry: p ? p.spotAtEntry : null,
        armed: null,
        pivots: pv ? { pp: pv.pp, r1: pv.r1, s1: pv.s1, from: pv.from } : null,
      };
    }
    return {
      candles, emaFast: ema(k.emaFast), emaSlow: ema(k.emaSlow), emaFastLen: k.emaFast, emaSlowLen: k.emaSlow,
      rsi: candles.length > 15 ? line(RSI.calculate({ period: 14, values: closes })) : [],
      rsiCeMin: k.rsiCeMin, rsiPeMax: k.rsiPeMax, supertrend, markers,
      stopLoss: p && Number.isFinite(p.stopLoss) ? p.stopLoss : null, entry: p ? p.spotAtEntry : null,
      armed: state.armed ? state.armed.triggerLevel : null,
    };
  }

  // Every recorded day, newest first, with its trades — for the History page.
  function historyDays() {
    return Object.entries(loadBook().days || {}).sort((a, b) => b[0].localeCompare(a[0]))
      .map(([day, d]) => ({ day, trades: d.trades || [], pnl: d.pnl || 0 }));
  }

  // Resume after an app restart (deploys land in the evening, mid session).
  setTimeout(() => {
    const r = _readJson(RUN_FILE, null);
    if (!r || r.day !== istDay()) { if (r) persistRunning(); return; }
    if (!modeOn()) return;
    start({ resumed: true }).then((res) => { if (!res.ok) log(`⚠️ Could not resume after restart: ${res.reason}`); });
  }, 20000).unref();

  // CMX_AUTO_START: start by itself each weekday once the session is open —
  // unless switched off, or stopped by hand today. One try per 5 minutes.
  let lastAutoTry = 0, closedUntil = 0;   // closedUntil: MCX-holiday quiet period (ms), set by _start
  setInterval(() => {
    if (state.running || state.starting || !modeOn()) return;
    if (String(process.env.CMX_AUTO_START || "false").toLowerCase() !== "true") return;
    if (state.manualStopDay === istDay() || Date.now() - lastAutoTry < 300000) return;
    const c = cfg(), m = istNowMinutes(), dow = istDow();
    if (dow === 0 || dow === 6 || m < c.sessStart || m >= c.eodExit) return;
    // A weekday MCX holiday was detected → quiet until the next session open.
    // Within the first bars after an open, wait: too early to tell a holiday.
    if (Date.now() < closedUntil) return;
    if (mcxHolidays.inOpenGrace({ nowMs: Date.now(), sessStartMin: c.sessStart, sessEndMin: c.sessEnd, resMin: c.res })) return;
    lastAutoTry = Date.now();
    start().then((res) => { if (!res.ok) log(`⚠️ Auto-start failed: ${res.reason}`); });
  }, 30000).unref();

  function fullLog() { return state.logs.join("\n"); }

  return { start, stop, reset, deleteDay, snapshot, fullLog, manualExit, manualEntry, chartData, historyDays, state, modeOn };
}

/** True while any commodity engine is running and wants live prices. */
function needsLiveFeed() { return hub.needs.size > 0; }

module.exports = { createEngine, needsLiveFeed };

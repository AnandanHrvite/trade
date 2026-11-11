/**
 * pairRuntime.js — what changes when ONE paper route runs a strategy on a
 * different market. Market-generic: nothing here knows any strategy's rules.
 * ─────────────────────────────────────────────────────────────────────────────
 * A converted paper route is a builder, `create(pair)` (see
 * routes/emaRsiStV2Paper.js — the pilot). The route keeps every rule of its own
 * and asks this module for everything that depends on the MARKET or on the
 * pair's IDENTITY:
 *
 *   const rt = pairRuntime.forPair(pairs.get("emaRsiStV2", "BANKNIFTY"));
 *
 * IDENTITY (strings — files, keys, slots, tags)
 *   rt.pair rt.strategy rt.home rt.isNiftyHome rt.marketKey
 *   rt.modeKey      logger / skipLogger / capitalPool key   "bn_ema_rsi_st_v2"
 *   rt.envPrefix    the pair's own env prefix               "BN_EMA_RSI_ST_V2"
 *   rt.tag          log / notify tag                        "BN_EMA_RSI_ST_V2"
 *   rt.paperPath    mount path                              "/bn_ema_rsi_st_v2-paper"
 *   rt.replayMode   tickReplay / tickRecorder mode          "bn_ema_rsi_st_v2-paper"
 *   rt.ownerId      socket callback / option-feed owner     "bn_ema_rsi_st_v2-paper"
 *   rt.tradesFile   ~/trading-data/<file>
 *   rt.notifyMode   notify() mode tag                       "BN_EMA_RSI_ST_V2-PAPER"
 *   rt.sidebarKey / rt.historySidebarKey   sharedNav active-page keys
 *   rt.title        human name                              "NIFTY BANK · EMA_RSI_ST_V2"
 *   A home pair (NIFTY) returns exactly the registry's existing values, so the
 *   NIFTY route is unchanged byte for byte.
 *
 * MARKET (read live — a Settings save applies on the next call)
 *   rt.market()            markets.get(marketKey)
 *   rt.kind                "options" | "futures" | "mcx"; rt.isFutures, rt.isMcx
 *   rt.U()                 instrument.underlyingOf row (null for MCX)
 *   rt.spotLabel           "NIFTY" on NIFTY (as the route always printed), else the market label
 *   rt.spotSymbol()        symbol the candles are built from (index / stock spot;
 *                          MCX: the series' future, null until the master is on hand)
 *   rt.resolveSpotSymbol() async — downloads the MCX master when needed
 *   rt.strikeStep() rt.atmOf(spot) rt.cacheTolerance()  strike grid helpers
 *   rt.lotQty()            contract qty incl. the clamped LOT_MULTIPLIER
 *   rt.instrumentName()    trade.instrument ("NIFTY_OPTIONS", "NIFTY_FUTURES", "SENSEX_OPTIONS" …)
 *   rt.resolveEntrySymbol(spot, side)  → Promise<{symbol, expiry, strike, invalid, staleExpiry?, overrideKey?}>
 *   rt.parseOptionSymbol(symbol)       → {expiry, expiryRaw, strike, optionType} | null
 *   rt.sessionOpenMin()    candle-build floor (09:15 NSE/BSE, 09:00 MCX)
 *   rt.startMins() rt.stopMins()       entry floor / session stop (TRADE_START/STOP_TIME on NSE/BSE)
 *   rt.isTradingAllowed()  async — exchange open today (weekend / holiday)
 *   rt.isExpiryDay(ms?)    the MARKET's expiry day (holiday-preponed), sync
 *   rt.oiApplies           the NIFTY-futures OI gate runs (home NIFTY only)
 *
 * PER-PAIR SETTINGS (own → home pair → default, config/pairs.js)
 *   rt.setting(homeKey, fallback)  pairs.resolve().value
 *   rt.enabled()           <PAIR>_MODE_ENABLED (non-home default OFF)
 *   rt.paperEnabled()      the strategy's *_PAPER_ENABLED, inherited
 *   rt.expiryDayOnly()     <PAIR>_EXPIRY_DAY_ONLY (home: not used — the NIFTY route keeps its own rule)
 *   rt.fillAtQuote()       <PAIR>_PAPER_FILL_AT_QUOTE (non-home default ON; NIFTY never)
 *   rt.maxSpreadPts()      <PAIR>_MAX_SPREAD_PTS → MAX_BID_ASK_SPREAD_PTS (undefined on NIFTY = the guard's own default)
 *   rt.entryFill(ltp, quote, nowMs) / rt.exitFill(...)  ask / bid of a fresh quote, else ltp
 *
 * SHARED SLOTS (one generic adapter per subsystem)
 *   rt.socketSlot  { mode, set(), clear(), isActive(), get(), canStart() }  sharedSocketState
 *   rt.persist     { save(position, meta), clear() }                         positionPersist
 *   rt.registerCapital()   capitalPool entry (non-home pairs draw on the Fyers pool)
 *
 * PAPER ONLY. Nothing here places an order.
 * ─────────────────────────────────────────────────────────────────────────────
 */

"use strict";

const pairs      = require("../config/pairs");
const markets    = require("../config/markets");
const registry   = require("../config/strategyRegistry");
const instrument = require("../config/instrument");

const MONTHS = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
const MONTH_CODE_MAP = { "1":0,"2":1,"3":2,"4":3,"5":4,"6":5,"7":6,"8":7,"9":8,"O":9,"N":10,"D":11 };

function _parseHHMM(raw, def) {
  const [h, m] = String(raw || def).split(":").map(Number);
  return h * 60 + (isNaN(m) ? 0 : m);
}
function _istMinOf(ms) { return Math.floor((Math.floor(ms / 1000) + 19800) / 60) % 1440; }
function _istYmd(ms) { return new Date(ms + 19800000).toISOString().slice(0, 10); }
function _truthy(v) { return String(v || "").trim().toLowerCase() === "true"; }

/** The clamped LOT_MULTIPLIER instrument.getLotQty applies (read off its own result). */
function _lotMultiplier() {
  const base = instrument.underlyingOf("NIFTY").lotSize;
  const q = instrument.getLotQty("NIFTY");
  return base > 0 ? Math.max(1, Math.round(q / base)) : 1;
}

/**
 * Parse a Fyers option symbol of one stem into its parts.
 *   exch / prefix  "NSE" / "NIFTY", "BSE" / "SENSEX", "MCX" / "CRUDEOIL" …
 *   weekly         false = monthly-only market: a YYMMM code is always the monthly form
 *   minMonthlyStrike  a YY+MMM+digits symbol is read as MONTHLY only when the
 *                  strike is at least this (else YY+MMM+DD+strike) — index rows
 * Formats: A  YY + M(1-9,O,N,D) + DD + strike   (weekly)
 *          C  YY + MMM + strike                 (monthly)
 *          B  YY + MMM + DD + strike            (older weekly)
 */
function parseOptionSymbolFor(symbol, { exch, prefix, weekly = true, minMonthlyStrike = 10000 }) {
  try {
    const s = String(symbol || "");
    const head = `${exch}:${prefix}`;
    if (!s.startsWith(head)) return null;
    const rest = s.slice(head.length);
    const NUM = "(\\d+(?:\\.\\d+)?)";
    if (weekly) {
      const mA = rest.match(new RegExp(`^(\\d{2})([1-9OND])(\\d{2})${NUM}(CE|PE)$`));
      if (mA) {
        const mon = MONTHS[MONTH_CODE_MAP[mA[2]]];
        return { expiry: `${mA[3]} ${mon} 20${mA[1]}`, expiryRaw: `${mA[1]}${mA[2]}${mA[3]}`, strike: parseFloat(mA[4]), optionType: mA[5] };
      }
    }
    const mC = rest.match(new RegExp(`^(\\d{2})([A-Z]{3})${NUM}(CE|PE)$`));
    if (mC) {
      const strike = parseFloat(mC[3]);
      if (!weekly || strike >= minMonthlyStrike) {
        return { expiry: `${mC[2]} 20${mC[1]}`, expiryRaw: `${mC[1]}${mC[2]}`, strike, optionType: mC[4] };
      }
    }
    if (weekly) {
      const mB = rest.match(new RegExp(`^(\\d{2}[A-Z]{3}\\d{2})${NUM}(CE|PE)$`));
      if (mB) {
        const raw = mB[1];
        return { expiry: `${raw.slice(5, 7)} ${raw.slice(2, 5)} 20${raw.slice(0, 2)}`, expiryRaw: raw, strike: parseFloat(mB[2]), optionType: mB[3] };
      }
    }
  } catch (_) {}
  return null;
}

/**
 * Pure fill rule for paper trades: buy at the ask / sell at the bid of a quote
 * no older than `freshMs`, else at `ltp`. Returns { price, source }.
 */
function quoteFill(side, ltp, quote, { enabled, nowMs = Date.now(), freshMs = 15000 } = {}) {
  if (enabled && quote && Number.isFinite(quote.at) && nowMs - quote.at <= freshMs) {
    const px = side === "buy" ? Number(quote.ask) : Number(quote.bid);
    if (px > 0) return { price: px, source: side === "buy" ? "ask" : "bid" };
  }
  return { price: ltp, source: "ltp" };
}

const _cache = new Map();

function forPair(pair) {
  if (!pair) throw new Error("pairRuntime.forPair: no pair");
  if (_cache.has(pair.id)) return _cache.get(pair.id);
  const s = registry.byId(pair.strategyId);
  const def = markets.MARKET_DEFS[pair.marketKey];
  const kind = def.kind;                              // options | futures | mcx
  const isNiftyHome = pair.home && pair.marketKey === "NIFTY";
  const underlyingKey = kind === "mcx" ? null : def.underlying;
  const market = () => markets.get(pair.marketKey);
  const U = () => (underlyingKey ? instrument.underlyingOf(underlyingKey) : null);
  const M0 = market();

  const rt = {
    pair, strategy: s, home: pair.home, isNiftyHome, marketKey: pair.marketKey,
    modeKey: pair.modeKey, envPrefix: pair.envPrefix, tag: pair.tag,
    paperPath: pair.paperPath, replayMode: pair.replayMode, ownerId: pair.replayMode,
    tradesFile: pair.tradesFile, notifyMode: `${pair.tag}-PAPER`,
    sidebarKey:        pair.home ? `${s.id}Paper`   : `pair:${pair.modeKey}:paper`,
    historySidebarKey: pair.home ? `${s.id}History` : `pair:${pair.modeKey}:history`,
    title: pair.home ? s.label : `${M0.label} · ${s.label}`,
    kind, isFutures: kind === "futures", isMcx: kind === "mcx",
    underlyingKey,
    spotLabel: pair.marketKey === "NIFTY" ? "NIFTY" : M0.label,
    oiApplies: isNiftyHome,
    market, U,
  };

  // ── symbols ────────────────────────────────────────────────────────────────
  rt.spotSymbol = () => {
    if (kind !== "mcx") return U().spot;
    const ser = require("../services/mcxContracts").peekSeries(market().contract);
    return ser ? ser.future : null;
  };
  rt.resolveSpotSymbol = async () => {
    if (kind !== "mcx") return U().spot;
    const ser = await require("../services/mcxContracts").resolveSeries(market().contract);
    return ser.future;
  };
  rt.strikeStep = () => (kind === "mcx" ? market().strikeStep : kind === "futures" ? null : U().strikeStep);
  // NIFTY keeps the literal 50-pt grid its route always printed with.
  rt.atmOf = (spot) => {
    const step = isNiftyHome ? 50 : (rt.strikeStep() || 1);
    return parseFloat((Math.round(spot / step) * step).toFixed(2));
  };
  // A pre-fetched symbol is reused while spot stays within half a strike (25 on NIFTY).
  rt.cacheTolerance = () => (isNiftyHome ? 25 : (rt.strikeStep() || 50) / 2);
  rt.lotQty = () => {
    if (isNiftyHome) return instrument.getLotQty();
    if (kind === "futures") return instrument.getLotQty(underlyingKey, "NIFTY_FUTURES");
    if (kind === "mcx") return market().lotSize * _lotMultiplier();
    return instrument.getLotQty(underlyingKey);
  };
  rt.instrumentName = () => {
    if (isNiftyHome) return instrument.INSTRUMENT;
    if (kind === "futures") return "NIFTY_FUTURES";
    if (kind === "mcx") return "MCX_OPTIONS";
    return `${underlyingKey}_OPTIONS`;
  };
  rt.resolveEntrySymbol = async (spot, side) => {
    if (isNiftyHome) return instrument.validateAndGetOptionSymbol(spot, side, pair.modeKey);
    if (kind === "futures") {
      const sym = await instrument.getSymbol(side, underlyingKey, "NIFTY_FUTURES");
      return { symbol: sym, expiry: null, strike: null, invalid: !sym };
    }
    if (kind === "mcx") {
      const mcx = require("../services/mcxContracts");
      const series = await mcx.resolveSeries(market().contract);
      const symbol = markets.optionSymbol(pair.marketKey, spot, side, { series });
      if (!symbol) return { symbol: null, expiry: null, strike: null, side, invalid: true };
      const p = rt.parseOptionSymbol(symbol);
      return { symbol, expiry: series.optionExpiry, expiryDate: series.optionExpiry, strike: p ? p.strike : null, side, invalid: false };
    }
    return instrument.validateAndGetOptionSymbol(spot, side, pair.modeKey, { underlying: underlyingKey });
  };
  rt.parseOptionSymbol = (symbol) => {
    if (kind === "futures") return null;
    if (kind === "mcx") return parseOptionSymbolFor(symbol, { exch: "MCX", prefix: market().contract, weekly: false });
    const u = U();
    return parseOptionSymbolFor(symbol, { exch: u.exchange, prefix: u.optPrefix, weekly: u.weekly, minMonthlyStrike: 10000 });
  };

  // ── session ────────────────────────────────────────────────────────────────
  rt.sessionOpenMin = () => (kind === "mcx" ? market().session.startMin : 9 * 60 + 15);
  rt.startMins = () => (kind === "mcx" ? market().session.startMin : _parseHHMM(process.env.TRADE_START_TIME, "09:15"));
  rt.stopMins  = () => (kind === "mcx" ? market().session.endMin   : _parseHHMM(process.env.TRADE_STOP_TIME,  "15:30"));
  rt.stopTimeLabel = () => {
    const m = rt.stopMins();
    return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  };
  rt.isTradingAllowed = async () => {
    if (kind !== "mcx") return require("../services/marketData").isTradingAllowed();
    return markets.isTradingDay(pair.marketKey)
      ? { allowed: true }
      : { allowed: false, reason: `${market().label}: MCX is closed today (weekend)` };
  };
  /** Is `nowMs` (default now) on this market's expiry day? Futures: the month's contract expiry. */
  rt.isExpiryDay = (nowMs = Date.now()) => {
    const today = _istYmd(nowMs);
    try {
      if (kind === "futures") {
        const ist = new Date(nowMs + 19800000);
        const local = new Date(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), 9, 15);
        const sched = instrument.monthlyExpiryAt(local, underlyingKey);
        const eff = require("./nseHolidays").preponedExpirySync(sched);
        return require("./nseHolidays").formatDateToYYYYMMDD(eff) === today;
      }
      const info = markets.expiryInfo(pair.marketKey, nowMs);
      return !!info.date && info.date === today;
    } catch (_) { return false; }
  };

  // ── per-pair settings ──────────────────────────────────────────────────────
  rt.setting = (homeKey, fallback) => pairs.resolve(pair, homeKey, process.env, fallback).value;
  rt.enabled = () => pairs.isEnabled(pair);
  rt.paperEnabled = () => {
    if (!s.paperEnabled) return true;
    return _truthy(rt.setting(s.paperEnabled.key, s.paperEnabled.default));
  };
  rt.expiryDayOnly = () => _truthy(rt.setting(`${s.envPrefix}_EXPIRY_DAY_ONLY`, "false"));
  rt.fillAtQuoteKey = pair.home ? null : `${pair.envPrefix}_PAPER_FILL_AT_QUOTE`;
  rt.maxSpreadKey   = pair.home ? null : `${pair.envPrefix}_MAX_SPREAD_PTS`;
  rt.fillAtQuote = () => {
    if (pair.home) return false;                       // NIFTY fills stay exactly as they are
    const v = process.env[rt.fillAtQuoteKey];
    return v === undefined || v === "" ? true : _truthy(v);
  };
  rt.maxSpreadPts = () => {
    if (pair.home) return undefined;                   // tradeGuards' own default (MAX_BID_ASK_SPREAD_PTS)
    for (const k of [rt.maxSpreadKey, "MAX_BID_ASK_SPREAD_PTS"]) {
      const n = parseFloat(process.env[k]);
      if (Number.isFinite(n) && n > 0) return n;
    }
    return 2;
  };
  rt.quoteFreshMs = () => Math.max(1, parseInt(process.env.LTP_STALE_THRESHOLD_SEC || "15", 10) || 15) * 1000;
  rt.entryFill = (ltp, quote, nowMs) => quoteFill("buy",  ltp, quote, { enabled: rt.fillAtQuote(), nowMs, freshMs: rt.quoteFreshMs() });
  rt.exitFill  = (ltp, quote, nowMs) => quoteFill("sell", ltp, quote, { enabled: rt.fillAtQuote(), nowMs, freshMs: rt.quoteFreshMs() });

  // ── shared slots ───────────────────────────────────────────────────────────
  const sss = () => require("./sharedSocketState");
  rt.socketSlot = pair.home
    ? {
        mode: s.socket.mode,
        set:      () => sss()[s.socket.set](s.socket.mode),
        clear:    () => sss()[s.socket.clear](),
        isActive: () => sss()[s.socket.isActive](),
        get:      () => sss()[s.socket.get](),
        canStart: (opts) => sss().canStart(s.socket.mode, opts),
      }
    : {
        mode: pair.socketMode,
        set:      () => sss().holdSlot(pair.socketMode),
        clear:    () => sss().releaseSlot(pair.socketMode),
        isActive: () => sss().slotHeld(pair.socketMode),
        get:      () => sss().heldSlotMode(pair.socketMode),
        canStart: (opts) => sss().canStart(pair.socketMode, opts),
      };
  if (!pair.home) sss().registerSlot(pair.socketMode, rt.title);

  const persistMod = () => require("./positionPersist");
  rt.persist = pair.home
    ? {
        // The registry strategy's own named functions (V2: saveEmaRsiStV2Position).
        save:  (pos, meta) => { const f = persistMod()[`save${_cap(s.id)}Position`]; if (f) f(pos, meta); },
        clear: () => { const f = persistMod()[`clear${_cap(s.id)}Position`]; if (f) f(); },
      }
    : {
        save:  (pos, meta) => persistMod().savePairPosition(pair.modeKey, pos, meta),
        clear: () => persistMod().clearPairPosition(pair.modeKey),
      };

  rt.registerCapital = () => {
    if (pair.home) return;
    require("./capitalPool").register(pair.modeKey, { broker: pair.broker, label: rt.title, file: pair.tradesFile });
  };

  _cache.set(pair.id, rt);
  return rt;
}

function _cap(id) { return id.charAt(0).toUpperCase() + id.slice(1); }

/** Runtime of a strategy on a market (home market when omitted). */
function forStrategy(strategyId, marketKey) {
  const p = pairs.get(strategyId, marketKey || pairs.homeMarket(strategyId));
  return p ? forPair(p) : null;
}

module.exports = { forPair, forStrategy, parseOptionSymbolFor, quoteFill, _internals: { _cache, _lotMultiplier } };

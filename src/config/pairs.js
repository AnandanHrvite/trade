/**
 * pairs.js — the (strategy, market) PAIR model: which env keys one strategy
 * reads on one market.
 * ─────────────────────────────────────────────────────────────────────────────
 * Config only. No engine runs a non-home pair yet; this file names the keys a
 * pair WILL read, so the sidebar and Settings can offer them today and the
 * engines can be pointed at them later without another key migration.
 *
 * KEY SCHEME
 *   Home pair (NIFTY for every strategy except SAIL_VWAP_ST, whose home is
 *   SAIL): exactly today's keys — envPrefix, modeKey and *_MODE_ENABLED come
 *   straight from strategyRegistry.js. Nothing is renamed.
 *
 *   Any other pair:
 *     env prefix   <MARKETPREFIX>_<STRATEGY ENV PREFIX>   BN_ORB, FUT_EMA_RSI_ST, SAIL_PA
 *     mode key     lower-case <marketprefix>_<modeKey>    bn_orb, fut_ema_rsi_st, sail_pa
 *     ON/OFF       <PAIRPREFIX>_MODE_ENABLED              default "false"
 *     trade days   <PAIRPREFIX>_EXPIRY_DAY_ONLY           "true" = expiry day only
 *   Market prefixes: NIFTY_FUT → FUT, BANKNIFTY → BN, SENSEX, CRUDE, GOLD,
 *   SILVER, and a stock by its own key (SAIL). NIFTY has no prefix as a home;
 *   for a strategy whose home is elsewhere its NIFTY pair uses NIFTY_.
 *   The BN_ / FUT_ spellings are the ones the engines' forPrefix() twins
 *   already read (FUT_EMA_RSI_ST_*, BN_PIVOT_EMA_ST_* …), so a key already in
 *   .env keeps meaning the same thing.
 *
 * SETTING LOOKUP for a non-home pair: its own key when set (non-empty), else the
 * home pair's value ("Same as NIFTY"), else the caller's schema default. Only
 * the strategy's OWN keys are per pair: a key under the strategy's env prefix
 * (EMA_RSI_ST also maps its legacy TRADE_* keys). Shared keys — global VIX,
 * RSI_CE_MIN, common trade rules — are not per pair and pairKey() returns null.
 *
 * OFFERED PAIRS: every kind:"strategy" registry entry on every market, except
 * a strategy that needs the 09:15 index open (needsIndexOpen) on an MCX market —
 * commodities have no NSE index open. The GAP_RUNAWAY stock scanner (kind:"tool")
 * is not paired; it stays under STOCKS as it is.
 *
 * RUNNING PAIRS: a strategy listed in RUNS_AS_PAIR has a paper route built by a
 * create(pair) builder (routes/<id>Paper.js — see utils/pairRuntime.js), so
 * every offered pair of it RUNS: its own route /<modeKey>-paper, trades file
 * <modeKey>_paper_trades.json, JSONL / skip logs under <modeKey>, socket slot
 * <ENVPREFIX>_PAPER and replay mode <modeKey>-paper. A strategy not listed
 * still has its pairs' keys and Settings panes, but nothing runs them.
 *
 * envGet(key): read a strategy key WITH pair inheritance — a non-home pair's
 * own value when set, else its home pair's value. Engines that take an env
 * prefix use it, so BN_EMA_RSI_ST_V2_EMA_FAST unset reads EMA_RSI_ST_V2_EMA_FAST.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const registry = require("./strategyRegistry");
const markets  = require("./markets");

// Market → env-key prefix. Stocks use their own key (SAIL → SAIL_).
const MARKET_PREFIX = {
  NIFTY: "NIFTY", NIFTY_FUT: "FUT", BANKNIFTY: "BN", SENSEX: "SENSEX",
  CRUDE: "CRUDE", GOLD: "GOLD", SILVER: "SILVER",
};

// A strategy whose identity is not NIFTY: its current keys are its pair on this
// market (SAIL_VWAP_ST trades SAIL stock options).
const HOME_MARKET = { sailVwapSt: "SAIL" };

// Legacy common keys that are not per strategy even though they carry the
// legacy prefix: TRADE_EXPIRY_DAY_ONLY is read by several strategies.
const SHARED_LEGACY_KEYS = new Set(["TRADE_EXPIRY_DAY_ONLY"]);

const MARKET_KEYS = Object.keys(markets.MARKET_DEFS);

// Strategies whose paper route is a create(pair) builder — every offered pair of
// these runs. Add a strategy's id here when its route is converted.
const RUNS_AS_PAIR = new Set(["emaRsiStV2", "emaRsiSt", "bbRsi", "pa"]);

function marketPrefix(marketKey) {
  const k = String(marketKey || "").toUpperCase();
  if (!markets.MARKET_DEFS[k]) return null;
  return MARKET_PREFIX[k] || k;   // stocks: their own key
}

function homeMarket(strategyId) { return HOME_MARKET[strategyId] || "NIFTY"; }

function _strategy(strategyId) {
  const s = registry.byId(strategyId);
  return s && s.kind === "strategy" ? s : null;
}

/** Is this strategy offered on this market? */
function isOffered(strategyId, marketKey) {
  const s = _strategy(strategyId);
  const def = markets.MARKET_DEFS[String(marketKey || "").toUpperCase()];
  if (!s || !def) return false;
  if (def.kind === "mcx" && s.needsIndexOpen) return false;
  return true;
}

/**
 * The pair, or null when the strategy is not offered there.
 *   { id, strategyId, marketKey, home, homeMarket, envPrefix, modeKey,
 *     enabledKey, enabledDefault, expiryDayOnlyKey, label, slug }
 */
function get(strategyId, marketKey) {
  const mk = String(marketKey || "").toUpperCase();
  if (!isOffered(strategyId, mk)) return null;
  const s = _strategy(strategyId);
  const home = homeMarket(strategyId) === mk;
  let envPrefix, modeKey, enabledKey, enabledDefault;
  if (home) {
    envPrefix = s.envPrefix;
    modeKey = s.modeKey;
    enabledKey = s.modeEnabled.key;
    enabledDefault = s.modeEnabled.default;
  } else {
    const mp = marketPrefix(mk);
    envPrefix = `${mp}_${s.envPrefix}`;
    modeKey = `${mp.toLowerCase()}_${s.modeKey}`;
    enabledKey = `${envPrefix}_MODE_ENABLED`;
    enabledDefault = "false";
  }
  const runs = RUNS_AS_PAIR.has(s.id);
  return {
    id: `${s.id}@${mk}`,
    strategyId: s.id,
    marketKey: mk,
    home,
    homeMarket: homeMarket(strategyId),
    envPrefix,
    modeKey,
    enabledKey,
    enabledDefault,
    expiryDayOnlyKey: `${envPrefix}_EXPIRY_DAY_ONLY`,
    label: s.label,
    // URL/DOM-safe id: the Settings page anchor (#pair-<slug>).
    slug: modeKey.replace(/[^a-z0-9]+/g, "-"),
    // Does a route run this pair (RUNS_AS_PAIR)? The identity below is the
    // one it runs under; a home pair's is the registry's own.
    runs,
    paperPath:  home ? s.paper.path : `/${modeKey}-paper`,
    replayMode: home ? s.paper.path.slice(1) : `${modeKey}-paper`,
    tradesFile: home ? s.tradesFile : `${modeKey}_paper_trades.json`,
    socketMode: home ? s.socket.mode : `${envPrefix}_PAPER`,
    // Upper-case tag for logs / notify ("BN_EMA_RSI_ST_V2"); home = its key.
    tag:        home ? s.key : envPrefix,
    broker:     home ? s.broker : "fyers",
  };
}

/** Every offered pair on one market, in sidebar (nav.order) order. */
function forMarket(marketKey) {
  return registry.strategies()
    .slice()
    .sort((a, b) => a.nav.order - b.nav.order)
    .map((s) => get(s.id, marketKey))
    .filter(Boolean);
}

/** Every offered pair, market by market (markets.js display order). */
// The pair list is static (registry × markets), so it is built once; callers
// get the same frozen objects every time.
let _all = null;
function all() {
  if (!_all) _all = MARKET_KEYS.flatMap(forMarket).map((p) => Object.freeze(p));
  return _all;
}

/** A pair by its mode key (bn_orb, ema_rsi_st …), or null. */
let _byMode = null;
function byModeKey(modeKey) {
  if (!_byMode) _byMode = new Map(all().map((p) => [p.modeKey, p]));
  return _byMode.get(String(modeKey || "")) || null;
}

/** A RUNNING non-home pair by its replay mode ("bn_ema_rsi_st_v2-paper"), or null. */
function byReplayMode(mode) {
  return all().find((p) => p.runs && !p.home && p.replayMode === mode) || null;
}

/**
 * Non-home pairs a route runs (RUNS_AS_PAIR), market by market. Pass
 * { enabledOnly: true } for the ones switched ON. This — not a hand-typed list —
 * is what Start All, the monitors, the logs, the consolidated page, replay and
 * the MCP mode list add to the registry's own strategies.
 */
function runnable(opts = {}, env = process.env) {
  const list = all().filter((p) => p.runs && !p.home);
  return opts.enabledOnly ? list.filter((p) => isEnabled(p, env)) : list;
}

// Longest-first non-home env prefixes, for envGet (BN_EMA_RSI_ST_V2 must win
// over BN_EMA_RSI_ST for "BN_EMA_RSI_ST_V2_EMA_FAST").
// Indexed by the key's first "_" token, so a NIFTY key (EMA_RSI_ST_V2_…) that
// no pair prefix can match costs one Map lookup — envGet runs on engine hot paths.
let _prefixIndex = null;
function _prefixesFor(key) {
  if (!_prefixIndex) {
    _prefixIndex = new Map();
    const list = all().filter((p) => !p.home)
      .map((p) => [p.envPrefix + "_", p])
      .sort((a, b) => b[0].length - a[0].length);
    for (const row of list) {
      const t = row[0].slice(0, row[0].indexOf("_"));
      if (!_prefixIndex.has(t)) _prefixIndex.set(t, []);
      _prefixIndex.get(t).push(row);
    }
  }
  const i = key.indexOf("_");
  return i > 0 ? (_prefixIndex.get(key.slice(0, i)) || []) : [];
}

/**
 * Value of one strategy env key with pair inheritance: the key's own value when
 * set (non-empty); for a non-home pair's key that is unset, the home pair's
 * value for the same setting. A key that belongs to no pair reads as itself.
 * Returns undefined when nothing is set (callers apply their own default).
 */
function envGet(key, env = process.env) {
  const k = String(key || "");
  const v = env[k];
  if (v !== undefined && v !== "") return v;
  for (const [pre, p] of _prefixesFor(k)) {
    if (!k.startsWith(pre)) continue;
    const s = _strategy(p.strategyId);
    const rest = k.slice(pre.length);
    for (const hp of [s.envPrefix, s.legacyEnvPrefix]) {
      if (!hp) continue;
      const hv = env[`${hp}_${rest}`];            // EMA_RSI_ST also maps its legacy TRADE_* keys
      if (hv !== undefined && hv !== "") return hv;
    }
    return undefined;
  }
  return v;
}

/** ON/OFF of a pair — non-home pairs default OFF. Read live. */
function isEnabled(pair, env = process.env) {
  if (!pair) return false;
  return String(env[pair.enabledKey] || pair.enabledDefault || "false").toLowerCase() === "true";
}

/**
 * The pair's key for one of its HOME pair's keys, or null when that key is
 * shared (not per strategy). The home pair maps every own key to itself.
 */
function pairKey(pair, homeKey) {
  if (!pair || !homeKey) return null;
  const s = _strategy(pair.strategyId);
  const k = String(homeKey);
  if (SHARED_LEGACY_KEYS.has(k)) return null;
  let rest = null;
  if (k.startsWith(`${s.envPrefix}_`)) rest = k.slice(s.envPrefix.length + 1);
  else if (s.legacyEnvPrefix && k.startsWith(`${s.legacyEnvPrefix}_`)) rest = k.slice(s.legacyEnvPrefix.length + 1);
  if (rest === null) return null;
  if (pair.home) return k;
  return `${pair.envPrefix}_${rest}`;
}

/**
 * Resolve one setting for a pair.
 *   { key, value, own, inherited, homeKey, homeValue }
 * value = own value if set, else the home pair's value, else `fallback`.
 * key is null (and inherited true) for a shared key — every pair reads the
 * home value.
 */
function resolve(pair, homeKey, env = process.env, fallback) {
  const _v = (k) => (k && env[k] !== undefined && env[k] !== "" ? String(env[k]) : undefined);
  const homeValue = _v(homeKey);
  const key = pairKey(pair, homeKey);
  const own = pair && !pair.home ? _v(key) : undefined;
  const base = homeValue !== undefined ? homeValue : fallback;
  if (!pair || pair.home) {
    return { key: homeKey, value: base, own: homeValue !== undefined, inherited: false, homeKey, homeValue };
  }
  return { key, value: own !== undefined ? own : base, own: own !== undefined, inherited: own === undefined, homeKey, homeValue };
}

module.exports = {
  MARKET_PREFIX,
  HOME_MARKET,
  RUNS_AS_PAIR,
  byReplayMode,
  runnable,
  envGet,
  marketPrefix,
  homeMarket,
  isOffered,
  get,
  forMarket,
  all,
  byModeKey,
  isEnabled,
  pairKey,
  resolve,
};

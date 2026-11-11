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
function all() { return MARKET_KEYS.flatMap(forMarket); }

/** A pair by its mode key (bn_orb, ema_rsi_st …), or null. */
function byModeKey(modeKey) { return all().find((p) => p.modeKey === modeKey) || null; }

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

/**
 * dashboardModel.js — what the Dashboard and the Real-Time Monitor list, and
 * under which market.
 * ─────────────────────────────────────────────────────────────────────────────
 * Derived, never hand-typed: every registry entry (config/strategyRegistry.js)
 * is a row on its HOME market, and every running non-home pair
 * (config/pairs.js runnable()) is a row on its own market. A strategy converted
 * to pairs (pairs.RUNS_AS_PAIR) therefore shows up on both pages, under each
 * market it runs on, with no edit here.
 *
 * Markets are the sidebar's Market → Strategy parents, in markets.js order:
 * NIFTY, NIFTY FUT, BANKNIFTY, SENSEX, CRUDE, GOLD, SILVER, then every stock
 * folded into one STOCKS group (the GAP_RUNAWAY stock scanner lives there too).
 *
 * Pure: reads process.env (or the env passed in) on every call, because a
 * Settings save changes it live.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const registry = require("../config/strategyRegistry");
const markets  = require("../config/markets");
const pairs    = require("../config/pairs");

// Display names match the sidebar's market parents.
const GROUP_LABEL = { NIFTY: "NIFTY", NIFTY_FUT: "NIFTY FUT", BANKNIFTY: "BANKNIFTY", STOCKS: "STOCKS" };

/** Market groups in display order: [{ key, label }]. Stocks collapse into STOCKS. */
const MARKET_GROUPS = (() => {
  const out = [];
  let stocks = false;
  for (const k of Object.keys(markets.MARKET_DEFS)) {
    if (markets.MARKET_DEFS[k].group === "stock") { stocks = true; continue; }
    out.push({ key: k, label: GROUP_LABEL[k] || k });
  }
  if (stocks) out.push({ key: "STOCKS", label: "STOCKS" });
  return Object.freeze(out.map((g) => Object.freeze(g)));
})();

/** The market group a market key belongs to (SAIL → STOCKS). */
function groupOf(marketKey) {
  const k = String(marketKey || "").toUpperCase();
  const def = markets.MARKET_DEFS[k];
  if (!def) return "NIFTY";
  return def.group === "stock" ? "STOCKS" : k;
}

// Card accent per registry key — the colours the monitor has always used.
// A strategy without one (a new registry entry) gets the neutral blue; every
// non-home pair shares the teal the monitor gave pairs.
const ACCENT = {
  EMA_RSI_ST: "#3b82f6", EMA_RSI_ST_V2: "#38bdf8", BB_RSI: "#f59e0b", PA: "#a855f7",
  ORB: "#10b981", EMA9VWAP: "#06b6d4", TREND_PB: "#ec4899", TDS: "#a855f7",
  HA_SCALP: "#f97316", PREV_ORB_SCALP: "#e879f9", ITM20_SCALP: "#22d3ee",
  RSI_PIVOT_ST: "#facc15", ST_RSI_PIV_BB: "#a3e635", SAIL_VWAP_ST: "#fda4af",
  PIVOT_EMA_ST: "#38bdf8", GAP_RUNAWAY: "#a78bfa", GAP_RUNAWAY_STK: "#c084fc",
  SIMPLE930: "#fb923c", EARLYBIRD: "#14b8a6",
};
const PAIR_ACCENT = "#2dd4bf";

// Routes that do not expose /download/{trades,skips}/:date (no Copy Day Log).
const NO_DAY_LOG = new Set(["TREND_PB"]);

let _pairTitle = null;
function pairTitle(p) {
  try {
    if (!_pairTitle) _pairTitle = require("./pairRuntime");
    return _pairTitle.forPair(p).title;
  } catch (_) {
    return `${p.marketKey} · ${p.label}`;
  }
}

/**
 * Every row the pages can show, ON or OFF:
 *   { key, label, title, market, marketKey, paperPrefix, modeFlag, defaultOn,
 *     broker, accent, hasDayLog, home, strategyId }
 * key    = the mode the consolidated trade list carries (registry key / pair env prefix)
 * label  = short name inside its market group; title = full name ("NIFTY BANK · …")
 */
function allRows() {
  const rows = registry.all().map((e) => {
    const marketKey = e.kind === "tool" ? "STOCKS" : pairs.homeMarket(e.id);
    return {
      key: e.key,
      label: e.label,
      title: e.label,
      market: e.kind === "tool" ? "STOCKS" : groupOf(marketKey),
      marketKey,
      paperPrefix: e.paper.path,
      modeFlag: e.modeEnabled.key,
      defaultOn: String(e.modeEnabled.default).toLowerCase() !== "false",
      broker: e.broker,
      accent: ACCENT[e.key] || "#3b82f6",
      hasDayLog: !NO_DAY_LOG.has(e.key),
      home: true,
      strategyId: e.id,
    };
  });
  for (const p of pairs.runnable()) {
    const market = groupOf(p.marketKey);
    rows.push({
      key: p.envPrefix,
      // Inside the STOCKS group the stock is the only thing telling two rows apart.
      label: market === "STOCKS" ? `${p.marketKey} · ${p.label}` : p.label,
      title: pairTitle(p),
      market,
      marketKey: p.marketKey,
      paperPrefix: p.paperPath,
      modeFlag: p.enabledKey,
      defaultOn: false,
      broker: p.broker,
      accent: PAIR_ACCENT,
      hasDayLog: true,
      home: false,
      strategyId: p.strategyId,
    });
  }
  return rows;
}

/** Is the row's *_MODE_ENABLED switch ON? */
function isOn(row, env = process.env) {
  const v = env[row.modeFlag];
  return String(v === undefined || v === "" ? (row.defaultOn ? "true" : "false") : v).toLowerCase() === "true";
}

/** Rows switched ON in Settings, grouped order (market by market). */
function enabledRows(env = process.env) {
  return sortByMarket(allRows().filter((r) => isOn(r, env)));
}

/** Stable sort: market display order, then the incoming order. */
function sortByMarket(rows) {
  const at = new Map(MARKET_GROUPS.map((g, i) => [g.key, i]));
  return rows.map((r, i) => [r, i])
    .sort((a, b) => ((at.get(a[0].market) ?? 99) - (at.get(b[0].market) ?? 99)) || (a[1] - b[1]))
    .map(([r]) => r);
}

/** Market groups that hold at least one of `rows`, display order. */
function marketsOf(rows) {
  const have = new Set(rows.map((r) => r.market));
  return MARKET_GROUPS.filter((g) => have.has(g.key));
}

/** { MODE_KEY: marketGroup } for the rows — trade.mode → market on the client. */
function modeMarketMap(rows) {
  return Object.fromEntries(rows.map((r) => [r.key, r.market]));
}

module.exports = { MARKET_GROUPS, groupOf, allRows, isOn, enabledRows, sortByMarket, marketsOf, modeMarketMap };

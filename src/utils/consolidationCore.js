/**
 * consolidationCore.js — the filter + totals maths behind /consolidation.
 *
 * ONE implementation, run in two places: the server (record defaults, the
 * regression test) and the browser. The page injects coreFactory's own source
 * text (clientScript()), so what the test checks is byte-for-byte what the
 * page runs — there is no second copy of the filter or the P&L sums to drift.
 *
 * That is why coreFactory is plain ES5-style code with no closure over this
 * module: anything it needs must live inside it.
 *
 * Record defaults (older trade records carry no `market` / strategy id):
 *   market   — the record's own `market` wins; otherwise from the book's log key:
 *              bn_* → BANKNIFTY, fut_* → NIFTY_FUT, cmx_crude|gold|silver_* →
 *              CRUDE|GOLD|SILVER, sail_vwap_st / sail_pivot_ema_st → SAIL,
 *              gap_runaway_stk → STOCKS, anything else NIFTY.
 *   strategy — the record's own id when it names a known strategy; otherwise the
 *              book's mode with its copy prefix stripped (BN_PIVOT_EMA_ST →
 *              PIVOT_EMA_ST, CMX_GOLD_EMA_RSI_ST_V2 → EMA_RSI_ST_V2, …).
 *
 * Expiry day is NOT decided here: it needs the NSE holiday calendar, so the
 * server stamps each row's `isExpiry` (true / false / null = unknown) through
 * expiryFlag() below, which holds the per-market hook.
 *
 * Read-only: nothing here writes a file or touches a broker.
 */

function coreFactory() {
  // ── Record defaults ────────────────────────────────────────────────────────
  var EXACT_MARKET = { sail_vwap_st: "SAIL", sail_pivot_ema_st: "SAIL", gap_runaway_stk: "STOCKS" };
  var PREFIX_MARKET = [
    ["bn_", "BANKNIFTY"], ["fut_", "NIFTY_FUT"],
    ["cmx_crude_", "CRUDE"], ["cmx_gold_", "GOLD"], ["cmx_silver_", "SILVER"],
  ];
  var MARKET_ALIAS = {
    "NIFTY50": "NIFTY", "NIFTY 50": "NIFTY", "NIFTY_OPTIONS": "NIFTY",
    "NIFTY_FUTURES": "NIFTY_FUT", "NIFTYFUT": "NIFTY_FUT",
    "BANK NIFTY": "BANKNIFTY", "NIFTY BANK": "BANKNIFTY", "NIFTYBANK": "BANKNIFTY", "BN": "BANKNIFTY",
    "CRUDEOIL": "CRUDE", "CRUDE OIL": "CRUDE",
  };
  function normMarket(m) {
    var u = String(m == null ? "" : m).trim().toUpperCase();
    if (!u) return "";
    return MARKET_ALIAS[u] || u.replace(/\s+/g, "_");
  }
  /** Market of one record. `logKey` is the book's file key, e.g. "bn_pivot_ema_st". */
  function marketOf(logKey, rec) {
    var own = rec && normMarket(rec.market);
    if (own) return own;
    var k = String(logKey || "").toLowerCase();
    if (EXACT_MARKET[k]) return EXACT_MARKET[k];
    for (var i = 0; i < PREFIX_MARKET.length; i++) {
      if (k.indexOf(PREFIX_MARKET[i][0]) === 0) return PREFIX_MARKET[i][1];
    }
    return "NIFTY";
  }
  // Copy books → the strategy they copied. Retired names only: the live
  // strategies' ids ARE their modes.
  var STRATEGY_ALIAS = { PIVOT_RSI_ST: "RSI_PIVOT_ST", GAP_RUNAWAY_STK: "GAP_RUNAWAY" };
  function baseStrategyOfMode(mode) {
    var m = String(mode || "").toUpperCase();
    if (m === "SAIL_PIVOT_EMA_ST") m = "PIVOT_EMA_ST";
    else m = m.replace(/^(BN|FUT)_/, "").replace(/^CMX_(CRUDE|GOLD|SILVER)_/, "");
    return STRATEGY_ALIAS[m] || m;
  }
  /** Strategy id of one record; `known` = { ID: true } of strategies the page lists. */
  function strategyOf(mode, rec, known) {
    var own = rec && (rec.strategyId || rec.tradeStrategy);
    if (own) {
      var u = String(own).trim().toUpperCase();
      if (known && known[u]) return u;
    }
    return baseStrategyOfMode(mode);
  }

  /** CE / BUY / LONG → "LONG", PE / SELL / SHORT → "SHORT" (bullish vs bearish). */
  function dirOf(side) {
    var s = String(side || "").toUpperCase();
    if (s === "CE" || s === "BUY" || s === "LONG") return "LONG";
    if (s === "PE" || s === "SELL" || s === "SHORT") return "SHORT";
    return "";
  }

  // Exit reasons are free text with prices in them ("SL hit @ 24012.5"), so the
  // filter works on a handful of buckets. A record's own category wins.
  var EXIT_CATS = ["Stop loss", "Trailing stop", "Target", "Profit lock", "Signal / reversal", "EOD / time", "Manual", "Other"];
  var CAT_ALIAS = { MANUAL: "Manual", PROFIT_LOCK: "Profit lock", SL: "Stop loss", STOP_LOSS: "Stop loss",
    TRAIL: "Trailing stop", TRAILING_STOP: "Trailing stop", TARGET: "Target", EOD: "EOD / time",
    TIME: "EOD / time", TIME_STOP: "EOD / time", SIGNAL: "Signal / reversal", REVERSAL: "Signal / reversal" };
  function exitCategory(rec) {
    var own = rec && rec.exitCategory;
    if (own) {
      var u = String(own).trim().toUpperCase().replace(/[\s/-]+/g, "_");
      if (CAT_ALIAS[u]) return CAT_ALIAS[u];
      for (var i = 0; i < EXIT_CATS.length; i++) if (EXIT_CATS[i].toUpperCase() === String(own).trim().toUpperCase()) return EXIT_CATS[i];
    }
    var r = String((rec && rec.exitReason) || "");
    if (!r) return "Other";
    if (/manual/i.test(r)) return "Manual";
    if (/profit[\s_-]*lock/i.test(r)) return "Profit lock";
    if (/trail/i.test(r)) return "Trailing stop";
    if (/time[\s_-]*stop|\beod\b|end[\s-]of[\s-]day|square[\s_-]*off|session (end|close)|market close|auto[\s_-]*exit|window (end|close)/i.test(r)) return "EOD / time";
    if (/target|take[\s_-]*profit|\btp\b/i.test(r)) return "Target";
    if (/\bsl\b|stop|hard[\s_-]*sl/i.test(r)) return "Stop loss";
    if (/revers|flip|opposite|signal|cross|engulf|re-?entry|supertrend|\bst\b|ema|vwap|\bbb\b|band|rsi/i.test(r)) return "Signal / reversal";
    return "Other";
  }

  function num(v) { var n = Number(v); return isFinite(n) ? n : null; }

  // "DD/MM/YYYY, HH:MM:SS", "HH:MM, DD/MM/YYYY" or an ISO instant → seconds into
  // the IST day (null when there is no clock in it). Used only to ORDER trades
  // inside one day for the drawdown walk.
  function clockSecs(v) {
    if (v == null || v === "") return null;
    var s = String(v);
    if (/^\d{4}-\d{2}-\d{2}T/.test(s)) {
      var t = Date.parse(s);
      if (isNaN(t)) return null;
      var d = new Date(t + 19800000);
      return d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds();
    }
    var c = s.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
    return c ? (+c[1]) * 3600 + (+c[2]) * 60 + (+(c[3] || 0)) : null;
  }
  function chronoKey(t) {
    var c = clockSecs(t.exitTime);
    if (c == null) c = clockSecs(t.entryTime);
    var p = c == null ? "999999" : ("000000" + c).slice(-6);
    return (t.date || "") + " " + p;
  }

  // ── Date presets (IST calendar days) ───────────────────────────────────────
  function istToday() { return new Date(Date.now() + 19800000).toISOString().slice(0, 10); }
  function ymd(d) { return d.toISOString().slice(0, 10); }
  var PRESETS = [["all", "All time"], ["td", "Today"], ["wk", "This week"], ["tm", "This month"], ["custom", "Custom"]];
  /** { from, to } inclusive 'YYYY-MM-DD' bounds, '' = open. today = IST 'YYYY-MM-DD'. */
  function resolveRange(f, today) {
    var p = (f && f.preset) || "all";
    var t = today || istToday();
    if (p === "td") return { from: t, to: t };
    if (p === "wk") {
      // Monday-start week; a Sunday belongs to the week that began on the Monday before.
      var d = new Date(t + "T00:00:00Z");
      var back = (d.getUTCDay() + 6) % 7;
      d.setUTCDate(d.getUTCDate() - back);
      return { from: ymd(d), to: t };
    }
    if (p === "tm") return { from: t.slice(0, 8) + "01", to: t };
    if (p === "custom") return { from: (f && f.from) || "", to: (f && f.to) || "" };
    return { from: "", to: "" };
  }

  // ── Filter state ⇄ URL query ───────────────────────────────────────────────
  var FILTER_KEYS = ["market", "strategy", "mode", "preset", "from", "to", "side", "result", "exit", "expiry", "q"];
  function emptyFilter() { return { market: "", strategy: "", mode: "", preset: "all", from: "", to: "", side: "", result: "", exit: "", expiry: "", q: "" }; }
  function parseQuery(search) {
    var f = emptyFilter();
    var sp = new URLSearchParams(String(search || "").replace(/^\?/, ""));
    for (var i = 0; i < FILTER_KEYS.length; i++) {
      var k = FILTER_KEYS[i], v = sp.get(k);
      if (v != null) f[k] = String(v).trim();
    }
    // A bare from/to (no preset) is a custom range — keeps hand-typed links working.
    if (!sp.get("preset") && (f.from || f.to)) f.preset = "custom";
    var okPreset = false;
    for (var j = 0; j < PRESETS.length; j++) if (PRESETS[j][0] === f.preset) okPreset = true;
    if (!okPreset) f.preset = "all";
    if (f.preset !== "custom") { f.from = ""; f.to = ""; }
    if (f.market) f.market = normMarket(f.market);
    if (f.strategy) f.strategy = f.strategy.toUpperCase();
    if (f.mode) f.mode = f.mode.toUpperCase();
    if (f.side) f.side = f.side.toUpperCase();
    if (f.result) f.result = f.result.toLowerCase();
    if (f.expiry) f.expiry = f.expiry.toLowerCase();
    return f;
  }
  function toQuery(f) {
    var sp = new URLSearchParams();
    for (var i = 0; i < FILTER_KEYS.length; i++) {
      var k = FILTER_KEYS[i], v = f && f[k];
      if (!v) continue;
      if (k === "preset" && v === "all") continue;
      if ((k === "from" || k === "to") && f.preset !== "custom") continue;
      sp.set(k, v);
    }
    var s = sp.toString();
    return s ? "?" + s : "";
  }

  // ── Filtering ──────────────────────────────────────────────────────────────
  function matches(t, f, range) {
    if (f.market && t.market !== f.market) return false;
    if (f.strategy && t.strategyId !== f.strategy) return false;
    if (f.mode && t.mode !== f.mode) return false;
    if (range.from && t.date < range.from) return false;
    if (range.to && t.date > range.to) return false;
    if (f.side) {
      if (f.side === "LONG" || f.side === "SHORT") { if (t.dir !== f.side) return false; }
      else if (String(t.side || "").toUpperCase() !== f.side) return false;
    }
    if (f.result === "win" && !(t.pnl > 0)) return false;
    if (f.result === "loss" && !(t.pnl < 0)) return false;
    if (f.exit && t.exitCat !== f.exit) return false;
    // Unknown expiry status (null) matches neither choice — never guessed.
    if (f.expiry === "expiry" && t.isExpiry !== true) return false;
    if (f.expiry === "non" && t.isExpiry !== false) return false;
    if (f.q) {
      var hay = ((t.symbol || "") + " " + (t.entryReason || "") + " " + (t.exitReason || "") + " " + (t.strategy || "") + " " + (t.mode || "")).toLowerCase();
      if (hay.indexOf(String(f.q).toLowerCase()) === -1) return false;
    }
    return true;
  }
  function filterTrades(trades, f, today) {
    var range = resolveRange(f, today);
    var out = [];
    for (var i = 0; i < trades.length; i++) if (matches(trades[i], f, range)) out.push(trades[i]);
    return out;
  }
  /** How many trades the expiry filter hid only because their expiry status is unknown. */
  function unknownExpiryHidden(trades, f, today) {
    if (!f.expiry) return 0;
    var g = {}; for (var k in f) g[k] = f[k];
    g.expiry = "";
    var range = resolveRange(g, today), n = 0;
    for (var i = 0; i < trades.length; i++) if (trades[i].isExpiry == null && matches(trades[i], g, range)) n++;
    return n;
  }

  // ── Totals ─────────────────────────────────────────────────────────────────
  // Every sum adds pnl exactly as each strategy's history page does (Number(pnl)
  // || 0, already applied when the row was built), so a filtered total agrees
  // with that page to the paisa.
  function totals(trades) {
    var o = { trades: trades.length, wins: 0, losses: 0, flats: 0, net: 0, gross: 0, charges: 0, chargesN: 0,
              grossWin: 0, grossLoss: 0, winRate: 0, avgWin: 0, avgLoss: 0, pf: null, expectancy: 0,
              maxDD: 0, ddPeakDate: "", ddTroughDate: "", best: null, worst: null };
    for (var i = 0; i < trades.length; i++) {
      var t = trades[i], p = t.pnl;
      o.net += p;
      o.gross += (t.gross != null ? t.gross : p);
      if (t.charges != null) { o.charges += t.charges; o.chargesN++; }
      if (p > 0) { o.wins++; o.grossWin += p; }
      else if (p < 0) { o.losses++; o.grossLoss += p; }
      else o.flats++;
      if (!o.best || p > o.best.pnl) o.best = t;
      if (!o.worst || p < o.worst.pnl) o.worst = t;
    }
    if (o.trades) { o.winRate = o.wins / o.trades * 100; o.expectancy = o.net / o.trades; }
    if (o.wins) o.avgWin = o.grossWin / o.wins;
    if (o.losses) o.avgLoss = o.grossLoss / o.losses;
    o.pf = o.grossLoss < 0 ? o.grossWin / -o.grossLoss : (o.grossWin > 0 ? Infinity : null);
    // Max drawdown on the net equity curve, walked oldest → newest.
    var ord = trades.slice().sort(function (a, b) { var x = chronoKey(a), y = chronoKey(b); return x < y ? -1 : x > y ? 1 : 0; });
    var eq = 0, peak = 0, peakDate = "";
    for (var j = 0; j < ord.length; j++) {
      eq += ord[j].pnl;
      if (eq > peak) { peak = eq; peakDate = ord[j].date; }
      var dd = peak - eq;
      if (dd > o.maxDD) { o.maxDD = dd; o.ddPeakDate = peakDate; o.ddTroughDate = ord[j].date; }
    }
    return o;
  }
  /** Rows of totals per key (market / strategyId / …), biggest net first. */
  function breakdown(trades, keyFn) {
    var groups = {}, order = [];
    for (var i = 0; i < trades.length; i++) {
      var k = keyFn(trades[i]) || "—";
      if (!groups[k]) { groups[k] = []; order.push(k); }
      groups[k].push(trades[i]);
    }
    var rows = [];
    for (var j = 0; j < order.length; j++) { var r = totals(groups[order[j]]); r.key = order[j]; rows.push(r); }
    rows.sort(function (a, b) { return b.net - a.net; });
    return rows;
  }
  /** One row per IST day, oldest first, with the running cumulative net. */
  function daily(trades) {
    var m = {}, keys = [];
    for (var i = 0; i < trades.length; i++) {
      var t = trades[i], d = t.date || "—";
      if (!m[d]) { m[d] = { date: d, trades: 0, wins: 0, losses: 0, net: 0, cum: 0 }; keys.push(d); }
      m[d].trades++; m[d].net += t.pnl;
      if (t.pnl > 0) m[d].wins++; else if (t.pnl < 0) m[d].losses++;
    }
    keys.sort();
    var cum = 0, out = [];
    for (var j = 0; j < keys.length; j++) { cum += m[keys[j]].net; m[keys[j]].cum = cum; out.push(m[keys[j]]); }
    return out;
  }

  return {
    EXIT_CATS: EXIT_CATS, PRESETS: PRESETS, FILTER_KEYS: FILTER_KEYS,
    normMarket: normMarket, marketOf: marketOf, baseStrategyOfMode: baseStrategyOfMode, strategyOf: strategyOf,
    dirOf: dirOf, exitCategory: exitCategory, num: num, clockSecs: clockSecs, chronoKey: chronoKey,
    istToday: istToday, resolveRange: resolveRange, emptyFilter: emptyFilter, parseQuery: parseQuery, toQuery: toQuery,
    matches: matches, filterTrades: filterTrades, unknownExpiryHidden: unknownExpiryHidden,
    totals: totals, breakdown: breakdown, daily: daily,
  };
}

const core = coreFactory();

/** `const CC = …;` — the same factory, for a page's inline <script>. */
function clientScript() {
  return "const CC = (" + coreFactory.toString() + ")();";
}

// ── Expiry day: the per-market hook ──────────────────────────────────────────
// A market listed here answers from its own exchange calendar. Any other
// market falls back to the record's own contract expiry date when it carries
// one as YYYY-MM-DD (expiryDate / optionExpiryDate), and is otherwise unknown
// (null) — never guessed. A new market adds one line here.
const EXPIRY_CALENDARS = {
  NIFTY:     (date) => require("./nseHolidays").isExpiryDateSync(date),
  NIFTY_FUT: (date) => require("./nseHolidays").isExpiryDateSync(date),   // the NIFTY weekly expiry day
};
const _ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
function expiryFlag(market, date, rec) {
  if (!date || !_ISO_DAY.test(date)) return null;
  const cal = EXPIRY_CALENDARS[market];
  if (cal) {
    try { return cal(date) === true; } catch (_) { return null; }
  }
  const own = rec && (rec.expiryDate || rec.optionExpiryDate);
  if (own && _ISO_DAY.test(String(own))) return String(own) === date;
  return null;
}

module.exports = { ...core, coreFactory, clientScript, expiryFlag, EXPIRY_CALENDARS };

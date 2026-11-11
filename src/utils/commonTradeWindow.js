// Common Trade Rules → "Trade window (all strategies)".
//
// One entry window for every NIFTY strategy except SIMPLE_9:30 and EarlyBird,
// whose whole rule is the opening candle. It only gates ENTRIES — there is no forced exit: the
// profit lock is the only automatic exit, and an open trade runs until it
// fires, the trader exits manually, or the session auto-stops.
//
// Each strategy keeps reading its own keys. While the rule is on, those keys
// are overridden in process.env ONLY — .env and the Settings page keep the
// strategy's own value, and it comes back the moment the rule is turned off.

const ENTRY_START = "10:00";
const ENTRY_END   = "14:00";

const ENTRY_START_KEYS = [
  "TRADE_ENTRY_START", "BB_RSI_ENTRY_START", "PA_ENTRY_START", "ORB_ENTRY_START",
  "EMA9VWAP_ENTRY_START", "TREND_PB_ENTRY_START", "HA_SCALP_ENTRY_START",
  "RSI_PIVOT_ST_ENTRY_START",
  "EMA_RSI_ST_V2_ENTRY_START",
  "ST_RSI_PIV_BB_ENTRY_START",
  "PIVOT_EMA_ST_ENTRY_START",
];
const ENTRY_END_KEYS = [
  // ORB_ENTRY_END is NOT here: ORB keeps its own, earlier cut-off (default 10:15 —
  // its late breakouts lost money in the Jan–Nov 2026 backtest).
  "TRADE_ENTRY_END", "BB_RSI_ENTRY_END", "PA_ENTRY_END",
  "EMA9VWAP_ENTRY_END", "TREND_PB_ENTRY_END", "TDS_ENTRY_END", "HA_SCALP_ENTRY_END",
  "PREV_ORB_SCALP_ENTRY_END", "RSI_PIVOT_ST_ENTRY_END",
  "EMA_RSI_ST_V2_ENTRY_END",
  "ST_RSI_PIV_BB_ENTRY_END",
  "PIVOT_EMA_ST_ENTRY_END",
];
const OVERRIDES = [
  ...ENTRY_START_KEYS.map(k => [k, ENTRY_START]),
  ...ENTRY_END_KEYS.map(k => [k, ENTRY_END]),
];

function _mins(hhmm) { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; }

// Unset = on, like the other Common Trade Rules.
function enabled() {
  return String(process.env.COMMON_TRADE_WINDOW_ENABLED ?? "true").toLowerCase() !== "false";
}

// Strategy's own value for each key while it is overridden (undefined = unset).
const _own = {};

/**
 * Apply or lift the overrides. Call once at boot and after every Settings
 * write, passing that write's updates/deletes so a strategy value saved while
 * the rule is on is remembered as its own value instead of being lost.
 */
function apply(updates = {}, deletes = []) {
  for (const k of deletes) if (k in _own) _own[k] = undefined;
  for (const [k, v] of Object.entries(updates)) if (k in _own) _own[k] = v;
  const on = enabled();
  for (const [k, v] of OVERRIDES) {
    if (on) {
      if (!(k in _own)) _own[k] = process.env[k];
      process.env[k] = v;
    } else if (k in _own) {
      if (_own[k] === undefined) delete process.env[k];
      else process.env[k] = _own[k];
      delete _own[k];
    }
  }
}

// Earliest entry minute, for engines whose start is not a key of their own.
function entryStartFloor(min) { return enabled() ? Math.max(min, _mins(ENTRY_START)) : min; }

module.exports = { apply, enabled, entryStartFloor, ENTRY_START, ENTRY_END };

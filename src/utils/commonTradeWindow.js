// Common Trade Rules → "Trade window (all strategies)".
//
// One entry window and one forced exit for every NIFTY / BANK NIFTY strategy
// except SIMPLE_9:30 and EarlyBird, whose whole rule is the opening candle.
// Commodity (MCX) keeps its own evening hours.
//
// Each strategy keeps reading its own keys. While the rule is on, those keys
// are overridden in process.env ONLY — .env and the Settings page keep the
// strategy's own value, and it comes back the moment the rule is turned off.
// BB_RSI and PA have no exit-time key (they square off at TRADE_STOP_TIME − 10),
// so their EOD checks call exitCap() instead.

const ENTRY_START = "10:00";
const ENTRY_END   = "14:00";
const FORCED_EXIT = "15:00";

const ENTRY_START_KEYS = [
  "TRADE_ENTRY_START", "BB_RSI_ENTRY_START", "PA_ENTRY_START", "ORB_ENTRY_START",
  "EMA9VWAP_ENTRY_START", "TREND_PB_ENTRY_START", "HA_SCALP_ENTRY_START",
  "RSI_PIVOT_ST_ENTRY_START", "BN_PIVOT_RSI_ST_ENTRY_START",
  "EMA_RSI_ST_V2_ENTRY_START", "BN_EMA_RSI_ST_V2_ENTRY_START",
  "ST_RSI_PIV_BB_ENTRY_START", "SAIL_VWAP_ST_ENTRY_START",
];
const ENTRY_END_KEYS = [
  "TRADE_ENTRY_END", "BB_RSI_ENTRY_END", "PA_ENTRY_END", "ORB_ENTRY_END",
  "EMA9VWAP_ENTRY_END", "TREND_PB_ENTRY_END", "TDS_ENTRY_END", "HA_SCALP_ENTRY_END",
  "PREV_ORB_SCALP_ENTRY_END", "RSI_PIVOT_ST_ENTRY_END", "BN_PIVOT_RSI_ST_ENTRY_END",
  "EMA_RSI_ST_V2_ENTRY_END", "BN_EMA_RSI_ST_V2_ENTRY_END",
  "ST_RSI_PIV_BB_ENTRY_END", "SAIL_VWAP_ST_ENTRY_END",
];
const EXIT_KEYS = [
  "EMA_RSI_ST_EOD_EXIT_TIME", "EMA9VWAP_EOD_EXIT_TIME", "ORB_FORCED_EXIT",
  "TREND_PB_FORCED_EXIT", "TDS_FORCED_EXIT", "HA_SCALP_FORCED_EXIT",
  "PREV_ORB_SCALP_FORCED_EXIT", "RSI_PIVOT_ST_EXIT_TIME", "BN_PIVOT_RSI_ST_EXIT_TIME",
  "EMA_RSI_ST_V2_EOD_EXIT_TIME", "BN_EMA_RSI_ST_V2_EOD_EXIT_TIME",
  "ST_RSI_PIV_BB_EOD_EXIT_TIME", "SAIL_VWAP_ST_EOD_EXIT_TIME",
];
const OVERRIDES = [
  ...ENTRY_START_KEYS.map(k => [k, ENTRY_START]),
  ...ENTRY_END_KEYS.map(k => [k, ENTRY_END]),
  ...EXIT_KEYS.map(k => [k, FORCED_EXIT]),
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
// Forced-exit minute, for engines whose exit is not a key of their own.
function exitCap(min) { return enabled() ? Math.min(min, _mins(FORCED_EXIT)) : min; }

module.exports = { apply, enabled, entryStartFloor, exitCap, ENTRY_START, ENTRY_END, FORCED_EXIT };

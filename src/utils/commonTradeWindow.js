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

// Each strategy's own entry-window keys come from the registry
// (strategyRegistry `commonWindow`). ORB has no end key there: it keeps its own,
// earlier cut-off (ORB_ENTRY_END, default 10:15 — its late breakouts lost money
// in the Jan–Nov 2026 backtest).
const _REG = require("../config/strategyRegistry").all();
const ENTRY_START_KEYS = _REG.map(s => s.commonWindow.start).filter(Boolean);
const ENTRY_END_KEYS   = _REG.map(s => s.commonWindow.end).filter(Boolean);
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

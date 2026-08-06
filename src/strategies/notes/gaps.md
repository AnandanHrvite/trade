# Gaps — change notes

Engine: `src/strategies/gaps.js` · Routes: `gaps*.js` · Env prefix: `GAPS_*`

Append a dated bullet whenever this strategy changes. Newest on top.

## Log
- 2026-08-06: Paper page no longer resurrects a PREVIOUS day's session on a trading day — the boot rehydrate's "last saved session" fallback (and the chart backfill that follows its trades' day) is now cleared unless today is a weekend/NSE holiday, so a restart with no trades yet shows today's empty session instead of yesterday's trades over yesterday's chart (new `src/utils/staleSessionGate.js`).
- 2026-08-05: entry now picks which RSI decides via dropdown `GAPS_RSI_ENTRY_SOURCE` (`today_open` default = today's-open-extended RSI, `prev_close` = yesterday's closed RSI); gap still measured vs yesterday's close. Settings select gained `{value,label}` option support.
<!-- - 2026-08-05: what changed and why -->

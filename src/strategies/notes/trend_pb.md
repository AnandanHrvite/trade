# Trend_PB — change notes

Engine: `src/strategies/trend_pb.js` · Routes: `trendPb*.js` · Env prefix: `TREND_PB_*`

Append a dated bullet whenever this strategy changes. Newest on top.

## Log
- 2026-08-06: Paper page no longer resurrects a PREVIOUS day's session on a trading day — the boot rehydrate's "last saved session" fallback (and the chart backfill that follows its trades' day) is now cleared unless today is a weekend/NSE holiday, so a restart with no trades yet shows today's empty session instead of yesterday's trades over yesterday's chart (new `src/utils/staleSessionGate.js`).
<!-- - 2026-08-05: what changed and why -->

# Trend_PB — change notes

Engine: `src/strategies/trend_pb.js` · Routes: `trendPb*.js` · Env prefix: `TREND_PB_*`

Append a dated bullet whenever this strategy changes. Newest on top.

## Log
- 2026-08-09: the held option contract is now streamed on the shared Fyers websocket (new `src/utils/optionFeed.js`) instead of this engine fetching it with its own repeated `getQuotes` poll — the premium the exit rules read updates per tick rather than once per poll interval, and the REST call only fires when the stream is quiet. The poll loop stays, as both the fallback and what renews the subscription lease, so `OPTION_SOCKET_FEED_ENABLED=false` (or a feed whose ticks carry no resolvable symbol) restores the previous behaviour exactly.
- 2026-08-08: paper entries now report against the shared Fyers capital pool (`src/utils/capitalPool.js`) — the exact `qty × option LTP` is blocked on entry and released with the net P&L on exit. Advisory only: an entry the pool cannot fund is still taken and raises the Real-Time dashboard alert instead of being skipped.
- 2026-08-06: Paper page no longer resurrects a PREVIOUS day's session on a trading day — the boot rehydrate's "last saved session" fallback (and the chart backfill that follows its trades' day) is now cleared unless today is a weekend/NSE holiday, so a restart with no trades yet shows today's empty session instead of yesterday's trades over yesterday's chart (new `src/utils/staleSessionGate.js`).
<!-- - 2026-08-05: what changed and why -->

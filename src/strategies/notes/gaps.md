# Gaps — change notes

Engine: `src/strategies/gaps.js` · Routes: `gaps*.js` · Env prefix: `GAPS_*`

Append a dated bullet whenever this strategy changes. Newest on top.

## Log
- 2026-08-11: Backtest now applies the `GAPS_MAX_WEEKLY_LOSS` cap, computed over the same ISO week (Mon→day) paper's `weeklyPnl()` reads from the JSONL logs. It is the only one of paper's four risk gates that can bind here — trade count, daily loss and loss streak all live in paper's per-session state, which resets each morning, and both engines take at most one trade per day.
- 2026-08-09: the held option contract is now streamed on the shared Fyers websocket (new `src/utils/optionFeed.js`) instead of this engine fetching it with its own repeated `getQuotes` poll — the premium the exit rules read updates per tick rather than once per poll interval, and the REST call only fires when the stream is quiet. The poll loop stays, as both the fallback and what renews the subscription lease, so `OPTION_SOCKET_FEED_ENABLED=false` (or a feed whose ticks carry no resolvable symbol) restores the previous behaviour exactly.
- 2026-08-08: moved the capital-pool check below the `stop_uncomputable` abort in `simulateBuy` — it sat above it, so a run that refused to enter (no computable stop) could still file a "pool exhausted" alert for a trade that never happened.
- 2026-08-08: paper entries now report against the shared Fyers capital pool (`src/utils/capitalPool.js`) — the exact `qty × option LTP` is blocked on entry and released with the net P&L on exit. Advisory only: an entry the pool cannot fund is still taken and raises the Real-Time dashboard alert instead of being skipped.
- 2026-08-06: Paper page no longer resurrects a PREVIOUS day's session on a trading day — the boot rehydrate's "last saved session" fallback (and the chart backfill that follows its trades' day) is now cleared unless today is a weekend/NSE holiday, so a restart with no trades yet shows today's empty session instead of yesterday's trades over yesterday's chart (new `src/utils/staleSessionGate.js`).
- 2026-08-05: entry now picks which RSI decides via dropdown `GAPS_RSI_ENTRY_SOURCE` (`today_open` default = today's-open-extended RSI, `prev_close` = yesterday's closed RSI); gap still measured vs yesterday's close. Settings select gained `{value,label}` option support.
<!-- - 2026-08-05: what changed and why -->

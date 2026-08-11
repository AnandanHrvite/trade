# BB_RSI — change notes

Engine: `src/strategies/bb_rsi.js` · Routes: `bbRsi*.js` · Env prefix: `BB_RSI_*`

Append a dated bullet whenever this strategy changes. Newest on top.

## Log
- 2026-08-11: light-theme `.run-btn` colour on the Backtest page — the dark navy fill had no entry in the light skin's hex rewriter, so it stayed a dark-theme button on a light page. Now a solid blue button with a white label (5.2:1). Styling only.
- 2026-08-10: Live page no longer shows an "Option SL" tile. It rendered `entry premium × (1 − OPT_STOP_PCT)`, but that key is EMA_RSI_ST's — no BB_RSI exit (engine, paper or backtest) ever referenced the number, so the page was advertising a stop that could not fire. Display-only removal; exits are unchanged.
- 2026-08-09: the held option contract is now streamed on the shared Fyers websocket (new `src/utils/optionFeed.js`) instead of this engine fetching it with its own repeated `getQuotes` poll — the premium the exit rules read updates per tick rather than once per poll interval, and the REST call only fires when the stream is quiet. The poll loop stays, as both the fallback and what renews the subscription lease, so `OPTION_SOCKET_FEED_ENABLED=false` (or a feed whose ticks carry no resolvable symbol) restores the previous behaviour exactly.
- 2026-08-08: paper entries now report against the shared Fyers capital pool (`src/utils/capitalPool.js`). Entry is synchronous and the premium only lands on the first option poll, so `qty × PAPER_CAPITAL_EST_PREMIUM` is blocked up front and corrected to the real premium there; released with the net P&L on exit. Advisory only — an unfundable entry is still taken and raises the Real-Time dashboard alert.
- 2026-08-07: Backtest "Run Again" no longer forces 5-min — the hidden resolution input now carries the run's actual resolution (digits-only, so the `?resolution=` query param can't break out of the attribute).
- 2026-08-07: Candle timeframe is now global — `BB_RSI_RESOLUTION` removed from Live/Paper/Backtest and Settings; all three read `TRADE_RESOLUTION` (Settings → Instrument & Backtest), same as every other strategy.
- 2026-08-06: Paper page no longer resurrects a PREVIOUS day's session on a trading day — the boot rehydrate's "last saved session" fallback (and the chart backfill that follows its trades' day) is now cleared unless today is a weekend/NSE holiday, so a restart with no trades yet shows today's empty session instead of yesterday's trades over yesterday's chart (new `src/utils/staleSessionGate.js`).
<!-- - 2026-08-05: what changed and why -->

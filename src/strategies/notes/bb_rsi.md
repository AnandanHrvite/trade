# BB_RSI — change notes

Engine: `src/strategies/bb_rsi.js` · Routes: `bbRsi*.js` · Env prefix: `BB_RSI_*`

Append a dated bullet whenever this strategy changes. Newest on top.

## Log
- 2026-08-07: Backtest "Run Again" no longer forces 5-min — the hidden resolution input now carries the run's actual resolution.
- 2026-08-07: Candle timeframe is now global — `BB_RSI_RESOLUTION` removed from Live/Paper/Backtest and Settings; all three read `TRADE_RESOLUTION` (Settings → Instrument & Backtest), same as every other strategy.
- 2026-08-06: Paper page no longer resurrects a PREVIOUS day's session on a trading day — the boot rehydrate's "last saved session" fallback (and the chart backfill that follows its trades' day) is now cleared unless today is a weekend/NSE holiday, so a restart with no trades yet shows today's empty session instead of yesterday's trades over yesterday's chart (new `src/utils/staleSessionGate.js`).
<!-- - 2026-08-05: what changed and why -->

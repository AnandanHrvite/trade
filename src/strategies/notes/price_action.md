# PA (Price Action) — change notes

Engine: `src/strategies/price_action.js` · Routes: `pa*.js` · Env prefix: `PA_*`

Append a dated bullet whenever this strategy changes. Newest on top.

## Log
- 2026-08-07: Candle timeframe is now global — `PA_RESOLUTION` removed from Live/Paper/Backtest (incl. the per-pattern backtest) and Settings; all read `TRADE_RESOLUTION` (Settings → Instrument & Backtest), same as every other strategy.
- 2026-08-06: Paper page no longer resurrects a PREVIOUS day's session on a trading day — the boot rehydrate's "last saved session" fallback (and the chart backfill that follows its trades' day) is now cleared unless today is a weekend/NSE holiday, so a restart with no trades yet shows today's empty session instead of yesterday's trades over yesterday's chart (new `src/utils/staleSessionGate.js`).
<!-- - 2026-08-05: what changed and why -->

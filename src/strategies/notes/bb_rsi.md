# BB_RSI — change notes

Engine: `src/strategies/bb_rsi.js` · Routes: `bbRsi*.js` · Env prefix: `BB_RSI_*`

Append a dated bullet whenever this strategy changes. Newest on top.

## Log
- 2026-08-08: paper entries now report against the shared Fyers capital pool (`src/utils/capitalPool.js`). Entry is synchronous and the premium only lands on the first option poll, so `qty × PAPER_CAPITAL_EST_PREMIUM` is blocked up front and corrected to the real premium there; released with the net P&L on exit. Advisory only — an unfundable entry is still taken and raises the Real-Time dashboard alert.
- 2026-08-07: Backtest "Run Again" no longer forces 5-min — the hidden resolution input now carries the run's actual resolution (digits-only, so the `?resolution=` query param can't break out of the attribute).
- 2026-08-07: Candle timeframe is now global — `BB_RSI_RESOLUTION` removed from Live/Paper/Backtest and Settings; all three read `TRADE_RESOLUTION` (Settings → Instrument & Backtest), same as every other strategy.
- 2026-08-06: Paper page no longer resurrects a PREVIOUS day's session on a trading day — the boot rehydrate's "last saved session" fallback (and the chart backfill that follows its trades' day) is now cleared unless today is a weekend/NSE holiday, so a restart with no trades yet shows today's empty session instead of yesterday's trades over yesterday's chart (new `src/utils/staleSessionGate.js`).
<!-- - 2026-08-05: what changed and why -->

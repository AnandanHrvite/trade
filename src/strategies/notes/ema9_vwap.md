# EMA9_VWAP — change notes

Engine: `src/strategies/ema9_vwap.js` · Routes: `ema9vwap*.js` · Env prefix: `EMA9_VWAP_*`

Append a dated bullet whenever this strategy changes. Newest on top.

## Log
- 2026-08-08: paper entries now report against the shared Zerodha capital pool (`src/utils/capitalPool.js`). Entry is synchronous and the premium only lands on the first option poll, so `qty × PAPER_CAPITAL_EST_PREMIUM` is blocked up front and corrected to the real premium there; released with the net P&L on exit. Advisory only — an unfundable entry is still taken and raises the Real-Time dashboard alert.
- 2026-08-07: Candle timeframe is now global — `EMA9VWAP_RESOLUTION` removed from Paper/Backtest and Settings; both read `TRADE_RESOLUTION` (Settings → Instrument & Backtest), same as every other strategy.
- 2026-08-06: Paper page no longer resurrects a PREVIOUS day's session on a trading day — the boot rehydrate's "last saved session" fallback (and the chart backfill that follows its trades' day) is now cleared unless today is a weekend/NSE holiday, so a restart with no trades yet shows today's empty session instead of yesterday's trades over yesterday's chart (new `src/utils/staleSessionGate.js`).
- 2026-08-05: Removed the 0DTE expiry-day guard entirely (Paper) — no more `/start` refusal, `EXPIRY_DAY_0DTE` modal, or `?force=1` bypass. Intraday-only, so same-day expiry is a normal session. Dropped the detector helpers and the frontend confirm flow (`force` param gone from `handleStart`).
- 2026-08-05: Dropped the per-strategy expiry override — 0DTE guard now reads the common OPTION_EXPIRY_OVERRIDE only (all strategies share one intraday expiry). Removed EMA9VWAP_OPTION_EXPIRY_* from Settings.
<!-- - 2026-08-05: what changed and why -->

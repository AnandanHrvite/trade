# EMA_RSI_ST — change notes

Engine: `src/strategies/strategy1_sar_ema_rsi.js` · Routes: `emaRsiSt*.js` · Env prefix: `VIX_*` / core swing keys

Append a dated bullet whenever this strategy changes. Newest on top.

## Log
- 2026-08-05: Removed the 0DTE expiry-day guard entirely (Paper + Live) — no more `/start` refusal, `EXPIRY_DAY_0DTE` modal, or `?force=1` bypass. We trade intraday only, so same-day expiry is just a normal session; the block was optional risk friction. Dropped the detector helpers and the frontend confirm flow (`force` param gone from `handleStart`/`ltHandleStart`).
- 2026-08-05: Dropped the per-strategy expiry override — 0DTE guard now reads the common OPTION_EXPIRY_OVERRIDE only (all strategies share one intraday expiry). Removed EMA_RSI_ST_OPTION_EXPIRY_* from Settings.
<!-- - 2026-08-05: what changed and why -->

# EMA9_VWAP — change notes

Engine: `src/strategies/ema9_vwap.js` · Routes: `ema9vwap*.js` · Env prefix: `EMA9_VWAP_*`

Append a dated bullet whenever this strategy changes. Newest on top.

## Log
- 2026-08-05: Removed the 0DTE expiry-day guard entirely (Paper) — no more `/start` refusal, `EXPIRY_DAY_0DTE` modal, or `?force=1` bypass. Intraday-only, so same-day expiry is a normal session. Dropped the detector helpers and the frontend confirm flow (`force` param gone from `handleStart`).
- 2026-08-05: Dropped the per-strategy expiry override — 0DTE guard now reads the common OPTION_EXPIRY_OVERRIDE only (all strategies share one intraday expiry). Removed EMA9VWAP_OPTION_EXPIRY_* from Settings.
<!-- - 2026-08-05: what changed and why -->

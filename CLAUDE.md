# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install            # one-time
npm run dev            # nodemon watcher on src/
npm start              # plain node src/app.js
node -c src/app.js     # syntax check (already allow-listed)
pm2 startOrRestart ecosystem.config.js --update-env   # production reload
```

There is no test runner, lint task, or build step. `node -c` is the fastest correctness gate before pushing. Pushes to `main` auto-deploy to EC2 via [.github/workflows/deployCodeToEc2.yml](.github/workflows/deployCodeToEc2.yml) — the workflow pins Node 16 (Amazon Linux 2 / GLIBC 2.17) and uses `pm2 startOrRestart ecosystem.config.js --update-env` so [ecosystem.config.js](ecosystem.config.js) changes take effect. PM2 treats exit code **10** as a "do not restart" config-error sentinel — used by [src/app.js](src/app.js) to break crash loops on missing certs / malformed env.

## Big-picture architecture

One Node/Express process hosts **all** trading engines — they share a single Fyers tick feed:

```
Fyers WebSocket (NIFTY50 spot)
        │
   socketManager  ← singleton, multi-callback fan-out ([src/utils/socketManager.js](src/utils/socketManager.js))
        │
  ┌─────┼──────────────┬────────────────┬──────────────┐
 Swing  Scalp           PA              ORB            Straddle
 (5/15m, Zerodha)  (5m, Fyers)   (5m, Fyers)      (Fyers)        (Fyers)
  │                │              │                │              │
  ├─Live           ├─Live         ├─Live           ├─Live         ├─Live
  ├─Paper          ├─Paper        ├─Paper          ├─Paper        ├─Paper
  └─Backtest       └─Backtest     └─Backtest       └─Backtest     └─Backtest
```

Key invariants:

- **Never open a second Fyers socket.** Subscribe through [socketManager](src/utils/socketManager.js); fan-out is what lets all strategies coexist on one connection.
- **[sharedSocketState](src/utils/sharedSocketState.js)** enforces per-strategy mutual exclusion (Swing Live ⊥ Swing Paper, etc.) while allowing cross-strategy parallelism. Don't bypass it when adding a new mode.
- **Three brokers, one router**: [zerodhaBroker.js](src/services/zerodhaBroker.js) (Swing live), [fyersBroker.js](src/services/fyersBroker.js) (Scalp/PA/ORB/Straddle live + all data). Token + reconnect logic lives there — don't re-implement OAuth at the route layer.
- **VIX gate**: [vixFilter.js](src/services/vixFilter.js) is called per strategy with its own thresholds (Swing uses `VIX_*`, others use `SCALP_VIX_*` / `PA_VIX_*` with fallback to the global keys).
- **Trade guards** (bid-ask spread, time-stop) live in [tradeGuards.js](src/utils/tradeGuards.js) and are shared across modes. Per-mode overrides (e.g., `PA_TIME_STOP_*`) read the same helper.
- **Crash recovery**: positions persisted via [positionPersist.js](src/utils/positionPersist.js); on boot, [app.js](src/app.js) reconciles each strategy's `.active_*_position.json` against broker state and Telegrams the user on orphan detection.

## Route layer convention

Every mode = its own router under [src/routes/](src/routes/), mounted in [src/app.js](src/app.js) at lines ~344–381. Three-route pattern per strategy: `{name}Live.js` / `{name}Paper.js` / `{name}Backtest.js` (PA adds `paLiveHarness.js` for the paper-wrapping harness and `paPatternBacktest.js` for per-pattern attribution). Routers render their own HTML (no templating engine) and own their `/status`, `/start`, `/stop`, `/data`, `/reset` sub-paths.

The unified pages live alongside: [realtime.js](src/routes/realtime.js) (Real-Time monitor), [replay.js](src/routes/replay.js) (tick replay), [allBacktest.js](src/routes/allBacktest.js) (unified backtest dashboard), [consolidation.js](src/routes/consolidation.js) / [liveConsolidation.js](src/routes/liveConsolidation.js) (cross-mode history), [tradeLogs.js](src/routes/tradeLogs.js) (per-mode JSONL viewer).

When wiring a **new** strategy or page, you must:

1. Add the router + mount it in `src/app.js` route block.
2. Add a sidebar entry in [src/utils/sharedNav.js](src/utils/sharedNav.js) — gated by an env-var toggle.
3. Expose that toggle in the [Settings UI](src/routes/settings.js). **No new menu item ships without a Settings toggle** (see memory: `feedback_new_pages_settings_toggle.md`).
4. Wire the strategy into [realtime.js](src/routes/realtime.js) and the dashboard rollups, gated by `{STRATEGY}_MODE_ENABLED`. New strategies don't ship invisible from the shared monitors — see memory `feedback_shared_monitor_new_strategy.md`.

## Paper logic is canonical

Paper routes are treated as the source of truth for decision/fill/exit semantics. When backtest or live behaviour diverges from paper, fix the backtest/live side — do **not** edit paper to match. See `feedback_paper_logic_untouchable.md` in memory.

## Persistent data

Everything stateful lives in `~/trading-data/` — **outside the repo**, so `git pull` and PM2 reloads never wipe it:

- `{swing,scalp,pa,orb,straddle}_paper_trades.json` / `_live_trades.json` — session-grouped trades
- `.active_{trade,scalp,pa}_position.json` — crash-recovery snapshots. **ORB and Straddle do not have crash-recovery snapshots yet** — `positionPersist.js` only handles Swing/Scalp/PA. Add helpers there if either strategy needs restart survival of an open position.
- `trades/{mode}_paper_trades_YYYY-MM-DD.jsonl` — per-day cumulative audit log (canonical export format). Seeded with a settings snapshot + checkpoint note; re-snapshotted whenever a save changes a key that affects that mode.
- `ticks/YYYY-MM-DD/*.jsonl` — recorded spot/option/VIX ticks, gated by `TICK_RECORDER_ENABLED` (default on). Source of truth for `/replay`. Retention `TICK_RECORDER_RETAIN_DAYS` (default 30).
- `_replay_trades/` — Replay outputs in snapshot mode (uses recorded session-start settings).
- `_replay_trades_sim/` — Replay outputs in current-settings mode (uses live `process.env`).
- `backtest_cache/`, `candle_cache/` — disk caches, auto-pruned.
- `.fyers_token`, `.zerodha_token` — OAuth tokens.

JSONL day files include settings snapshots written by [settings.js](src/routes/settings.js) on every save (with the checkpoint note the UI prompts for), so each day's log carries the exact config that produced its trades.

## Working in this repo

- **Autonomous push**: commits to `main` are expected to push immediately (IDE auto-sync). Stage *only* task files; no review window after commit. See `feedback_autonomous_push.md`.
- **Never** `--force` push, `--no-verify`, or bundle unrelated WIP into a commit.
- **Tuning is OPEN (deadline lifted 2026-05-27).** The paper-data-collection no-tuning window was ended early by the user; strategy tuning and bug fixes are now in scope for all strategies. The per-strategy notes in `project_{scalp,pa,swing}_post_window_observations.md` are still useful context (hypotheses + daily P&L track) — read them before tuning, but they are no longer a freeze. Caveat: trades generated *before* a bug fix were produced by buggy code — don't tune thresholds on pre-fix data; collect clean post-fix sessions first.
- **README.md is the user-facing spec** for env vars, routes, and per-strategy behaviour. Keep it in sync when adding env keys or routes.
- **CHANGELOG.md** is hand-maintained; add an entry for user-visible changes.
- **Live order placement is double-gated**: a strategy's `*_LIVE_ENABLED` toggle plus the global `LIVE_HARNESS_DRY_RUN`. When `LIVE_HARNESS_DRY_RUN=true` (default) the live engines log the broker call they would have made but place no real order. Flip the harness OFF only after the strategy's Paper and Live decisions match on a recorded session via `/replay`.
- **Tick recorder is the source of truth for Replay** — `TICK_RECORDER_ENABLED` must stay on for any session you want to replay deterministically. The recorder is a pure observer; treat it as additive-logging-only when touching its files.
- Indicators: use the `technicalindicators` package consistently (EMA/RSI/ADX/SAR/BB) — don't hand-roll new ones.
- Console output is intercepted by [services/logger.js](src/services/logger.js) (required *first* in `app.js`) and fed to `/logs` SSE — `console.log` is the logging API, not a debug crutch.

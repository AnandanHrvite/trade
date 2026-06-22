# Changelog

All notable changes to the Palani Andawar Trading Bot are documented in this file.

---

## Unreleased

### AI-friendly trade export across all trade-data download screens

- **New: every trade-data download now has a "🤖 AI" option** that produces a single self-describing Markdown report instead of raw JSONL/CSV — built for pasting straight into an AI for analysis. Each report carries a **summary table** (per-mode + total: trades, wins/losses, win %, net P&L, avg win/avg loss), a **field legend** (plain-English meaning of every field actually present), the **settings snapshot** that produced the trades (where available), then **per-strategy trade tables**.
- **Where it appears**: Trade Logs — both the **Trades** and **Skips** tabs: *Download Everything* (`?format=ai`, range-aware on Trades), per-mode *Download All*, and per-day *Download*; Consolidation and Live Consolidation (🤖 AI button next to ⬇ CSV — exports exactly the filtered set shown); and each Paper screen (Swing/Scalp/PA/ORB) via a *🤖 AI export* link that downloads the full per-trade log.
- **Skip logs** get a skip-shaped report instead of P&L stats: a per-gate breakdown (e.g. `vix (12), spread (5), strategy (3)`), a legend for the skip fields (gate / reason / spot / rsi / adx), then the rejections grouped by strategy — so an AI can answer "why didn't it trade?".
- **No new pages or menu items** — the option sits inline next to the existing download buttons, so there's nothing new to enable in Settings.
- **One shared format**: server-side file exports go through [src/utils/aiExport.js](src/utils/aiExport.js); the browser-filtered screens (Consolidation) render the identical structure via `aiExportJS()` in [src/utils/sharedNav.js](src/utils/sharedNav.js). Purely additive — no decision/fill/exit logic touched.

### Swing + Scalp: two-candle "cross & close" entry confirmation

- **New: entry now waits for a confirmation candle** (`SWING_CONFIRM_CANDLE_ENABLED` / `SCALP_CONFIRM_CANDLE_ENABLED`, both **default ON**). A fully-closed candle that meets all the strategy's entry rules becomes the *signal candle* — but no trade is taken on it. The **immediately-next** candle must then **cross that signal candle's close** (CE strictly above, PE strictly below); entry fires **intra-bar** the instant the cross happens. If the next candle never crosses, the armed signal expires; if that next candle is itself a fresh signal it re-arms (rolling). Filters the one-candle false breakouts that drove the losing CE entries on 22-Jun.
- **Behaviour change per mode**: Swing previously entered intra-candle the moment the live bar met the rules; Scalp entered at the signal candle's close. Both now gate on the next-candle cross. Turn the toggle OFF (Settings → Swing/Scalp) to restore the old behaviour — A/B the two in `/replay`.
- **Applied across all six surfaces** — `swingPaper`/`swingLive` + the shared swing `backtestEngine`, and `scalpPaper`/`scalpLive`/`scalpBacktest` — so paper, live, and backtest agree. Confirmation logic shared via [src/utils/confirmCandle.js](src/utils/confirmCandle.js) (toggle name, strict cross direction, and the backtest candle-granularity fill live in one place). Backtests model the intra-bar cross with the next candle's high/low and fill at the trigger (or the bar's open if it gapped through). All entry gates (VIX, OI, cooldowns, daily-loss, max-trades, spread) still apply — they're enforced at the cross (Swing) or at arm time on the signal candle's close (Scalp), exactly once.
- **Replay** runs the real paper `onTick`/`onCandleClose`, so it inherits confirmation automatically (verified the arm timing matches live — `tickReplay` flushes microtasks per tick). **Old-recording reproducibility**: snapshot-mode replay of sessions recorded *before* this feature (no `*_CONFIRM_CANDLE_ENABLED` in their snapshot) now forces the toggle **OFF** so they reproduce their original entries; `REPLAY_CACHE_VERSION` bumped to 7 to drop any results cached with confirmation wrongly ON. The live harnesses (which wrap paper) log the inherited confirm state on start.
- **UI**: the Paper/Live status banner now shows `🎯 ARMED <side> — waiting for next candle to cross <level>` (instead of always `FLAT`) while a signal candle has fired but isn't yet confirmed — on all four screens (server-render + the live 2 s poll) — and the chart draws a dashed amber `ARM` line at the trigger level until the cross or expiry. The activity log already records the arm and the cross.

### Paper screens: trades + chart markers survive a server restart

- **Fixed: pushing code (which restarts the server) wiped the running session's trades and chart markers from every Paper screen** (Swing/Scalp/PA/ORB). The Session Trades table and the entry/exit markers are drawn from the in-memory `sessionTrades`, which was only persisted to the saved `sessions[]` on **Stop**. A mid-session PM2 restart cleared it, so the screen came back empty even though the trades were safe in the per-trade JSONL day log.
- **Each paper mode now rehydrates the current session from today's JSONL on boot** — it loads today's trades that aren't already in a saved (stopped) session, restoring `sessionTrades`, `sessionPnl`, and the win/loss counts. In-memory only: **Stop** still does the persisted `sessions[]` save, so there's no double-counting. Settings-snapshot/meta lines in the day file are skipped; only real trade records are restored.
- **Fallback so the screen is never blank after a restart**: when there are no live trades for today (e.g. a restart outside market hours), each paper screen loads the **most recent saved session** instead. It's read-only display — `Start Paper` resets it to a fresh session, so the old trades can't be re-saved or double-counted. The `SESSION START` field shows that session's date as a hint. (Finished sessions also remain available under **History**.)
- **The chart comes back too, not just the table.** The candle series is live-only (`state.candles` fills from ticks), so a restored session still charted blank. Each chart now backfills the **spot candles for the restored trades' day** so the entry/exit markers (and EMA/SuperTrend/BB/ORB overlays) render. It's **cache-first** ([src/utils/chartBackfill.js](src/utils/chartBackfill.js) → `candleCache`): a day already cached from its live session draws with **no broker call**, which is what makes it work after market hours; if the day isn't cached and the broker fetch fails (e.g. a stale token), the chart simply stays empty and the trade table still shows. Result memoised per symbol/resolution/day (empty results aren't cached, so a page reload retries). Only triggers when **stopped with restored trades and no live candles** — live polling is untouched.
- **Decision/fill/exit logic untouched** — boot-time recovery only.

### Replay: snapshot mode now reproduces the OI & bid-ask spread gates

- **Fixed: snapshot replay could diverge from the recorded live session** whenever the OI filter or the bid-ask spread guard was active. Both gates read live broker data — NIFTY-futures OI, and option bid/ask — that the tick recorder never captured, so during replay they **failed open** and replay took entries the live run had blocked. One such phantom entry could land on a strike the live run never traded (no recorded option ticks → `spot proxy` fill), and the fake loss could trip the daily-loss cutoff and suppress the rest of the session. Affected all four strategies (ORB most exposed, at 1 trade/day).
- **Two new recorded streams** let replay run the exact same gates the live session did:
  - `ticks/YYYY-MM-DD/oi.jsonl` — NIFTY-futures OI samples, recorded from `oiFilter` (cache fills only, like VIX; only while an OI filter is on).
  - option `bid`/`ask` on the entry-time spread-guard quote, added to `options.jsonl` (`b`/`a` fields).
- **Replay harness** now serves recorded OI for `*FUT` quote requests and bid/ask on option quotes; the new recorder calls are no-op'd during replay so a replay never writes back into the recording.
- **Paper/live decision logic untouched** — recorder + replay only.
- **Pre-fix recordings can't be made deterministic** (the OI/bid-ask data was never captured). Snapshot replay now logs a one-line `⚠️ snapshot not fully reproducible` warning for such sessions instead of silently failing open, so a divergent delta isn't mistaken for a strategy result.

### Removed the Straddle strategy (all modes)

- **The Straddle (Long Straddle / BB-squeeze volatility) strategy has been removed entirely.** Deleted its routes (`/straddle-paper`, `/straddle-live`, `/straddle-backtest`), the `straddle_volatility.js` strategy, and the `Straddle_Strategy_Guide.html` doc. The platform now runs **four** strategies: Swing, Scalp, Price Action, and ORB.
- **All wiring scrubbed:** `app.js` route mounts + dashboard/monitor cards + shutdown reconciliation; `sharedSocketState` (`STRADDLE_PAPER`/`STRADDLE_LIVE` modes + helpers); `sharedNav` sidebar group; `settings.js` (the full Straddle strategy section, `STRADDLE_MODE_ENABLED`, the `UI_SHOW_STRADDLE_*` submenu toggles, and the `TG_STRADDLE_*` Telegram toggles); `realtime.js` card + position renderer; `replay.js` / `tickReplay.js` mode maps + socket-state stubs; `consolidation` / `edgeAnalytics` / `tradeLogs` / `cacheFiles` / `allBacktest` source maps + filters; `notify.js` (per-leg pair-stats + STRADDLE group); `vixFilter` per-mode readers; `tradeLogger` / `skipLogger` file maps; and the OI-filter exclusion note.
- **Env keys retired:** `STRADDLE_*`, `UI_SHOW_STRADDLE_*`, `TG_STRADDLE_*`, `STRADDLE_MODE_ENABLED` are no longer read anywhere (leaving them set in `.env` is harmless — they're simply ignored). The consolidated Telegram day report and Real-Time monitor now cover four strategies.
- **No impact on the other four strategies** — Swing/Scalp/PA/ORB decision, fill, exit, paper/live/backtest/replay paths are untouched. Existing `straddle_*` trade-data files in `~/trading-data/` are left in place (historical data; delete manually if desired).

### Replay: date-range result now has filters + per-strategy analytics

- **The date-range comparison result is now filterable.** A toolbar above the per-session table adds a **Strategy** picker (only shown for "All strategies" runs) and a **Show** picker — `All sessions` / `Improved vs live` / `Regressed vs live` / `Replay winning` / `Replay losing` / `Errored`. Filtering is instant and client-side (re-renders from the already-loaded results — no re-run), and the summary cards, verdict, stats, and charts all recompute to the filtered subset. A **Clear filters** button appears when a filter is active.
- **New session-level stats line:** sessions shown, replay win rate (winning sessions / total), average Δ per session, and the best/worst session by Δ vs live.
- **New per-strategy breakdown table** (shown only when a run spans ≥2 strategies, e.g. "All strategies"): per strategy — sessions, live P&L, replay P&L, Δ P&L, win rate, and improved/regressed counts. Respects the active filter.
- Filters reset on every new range run so a stale strategy/outcome filter can't hide fresh results.

### Telegram: hardened sends + in-dashboard failure banner

- **Telegram sends can no longer hang or kill the process.** The async `sendTelegram` now sets an 8s request timeout and destroys the socket on stall — previously a blocked/blackholed endpoint (e.g. the current govt block) accepted the connection but never answered, so `req.on("error")` never fired and the socket leaked open indefinitely. The whole send is wrapped so it always resolves (never rejects, never throws) regardless of payload or network state.
- **Delivery failures now surface in the UI.** `notify.js` tracks the last send failure (message, HTTP code, timestamp, consecutive-fail count) and exposes it via a new read-only `GET /auth/telegram-health` poll. A new amber banner in the shared nav (alongside the broker-socket banner) shows on every page when Telegram is failing, with the error detail; it clears on the next successful send and resets on restart. Dismiss snoozes it for 5 min. Not-configured stays silent (Telegram is optional).
- **Settings → System Health modal shows Telegram, with a live probe.** A new `Telegram` row runs an active `getMe` check (`GET /auth/telegram-ping`) every time the modal opens — `getMe` validates the token and confirms reachability but **sends no chat message**, so it can run on open without spamming. Shows `OK (reachable)` / `UNREACHABLE [code]` / `Not configured`; during a block it times out (8s) and reads `UNREACHABLE`. The probe also refreshes the banner state.
- The synchronous crash/shutdown path (`sendTelegramSync` via curl) now also records a coarse ok/fail from curl's exit code, so a blocked Telegram is visible even when only crash/circuit alerts fire.

### SCALP: reverted the RSI-band entry change

- **Reverted the RSI-band entry filter** (commits `f95f480` + `52ff31c`, 2026-06-19) — it made SCALP worse across replayed sessions. SCALP returns to the single-threshold rule: CE requires RSI > `SCALP_RSI_CE_THRESHOLD`, PE requires RSI < `SCALP_RSI_PE_THRESHOLD`. The four band keys (`SCALP_RSI_CE_MIN`/`_MAX`, `SCALP_RSI_PE_MIN`/`_MAX`) are retired; the two threshold keys, the Settings fields, and the docs are restored to their pre-band state.

### Replay: "current settings" mode auto-pins the recorded day's option expiry

- **Simulator (current-settings) replays now use the recorded day's option expiry instead of today's.** Previously a "My current settings" range replay applied the live `OPTION_EXPIRY_OVERRIDE` to every replayed day — so an old day was priced against this week's contract, which the recorded ticks don't cover (every quote missed → paper's spot-proxy fallback → nonsense P&L).
- The expiry keys (`OPTION_EXPIRY_OVERRIDE`/`_TYPE` and the per-mode `SWING_`/`SCALP_`/`PA_`/`ORB_`/`STRADDLE_` variants) are now pinned to the recorded session-start snapshot; a day that auto-detected its expiry falls back to computing it from the replay clock. **Every other setting still honors current Settings** — that's the whole point of the mode. Snapshot (deterministic) mode is unchanged.

### ORB: exits replaced with a single candle-structure trailing stop

- **ORB now exits on one stop only — the swing of the last `ORB_SL_CANDLES` (default 2) closed candles** (CE → lowest low, PE → highest high), recomputed and ratcheted in the favourable direction on every candle close. The same level is both the initial SL and the trail, so winners ride until structure breaks.
- **Removed** (all of them): the −25% premium SL, the opposite-OR-edge spot SL, the +40% premium / 1.5×-range spot **profit target**, move-to-breakeven, the one-shot premium lock-in, and the continuous-premium peak-giveback trail. The 15:15 EOD square-off is kept as the only non-stop exit. `ORB_TARGET_RANGE_MULT` survives only as an informational chart line.
- Wired identically across paper (canonical), live (legacy `/orb-live` + harness), and backtest. Settings UI drops the 8 now-dead exit knobs and exposes `ORB_SL_CANDLES` (placed next to Forced Square-Off). The dead env keys (`ORB_STOP_PCT`, `ORB_TARGET_PCT`, `ORB_PREMIUM_LOCKIN_*`, `ORB_TRAIL_*`) are no longer read by ORB.
- Status pages (paper + live) relabel the position tiles to match: **Trailing SL** (the candle stop), **Initial SL**, **Peak Premium** — replacing the now-meaningless Premium Stop / Premium Target tiles. The tick-recorder session snapshot now captures `ORB_*` keys (it previously matched every other strategy prefix but not ORB), so Replay snapshot-mode reproduces ORB config faithfully.

### Swing: negative-candle loss-cut + looser candle trail (chop fixes)

- **New `SWING_NEG_CANDLE_LIMIT` (default 2)** — asymmetric loss-cut: if a trade is still in the **red** (option premium below entry) at the close of N candles, square it off. Winners keep riding the EMA21 trail; losers don't bleed across the chop. `0` disables. Wired identically across paper (canonical), live, and backtest; exposed in Settings.
- **Candle-trail default loosened `2` → `3` bars** (`SWING_CANDLE_TRAIL_BARS`). The 2-bar trail sat right on the EMA cluster and stopped winners out on the first bounce in chop (19-Jun: most exits were the 2-bar trail, not the structural SL). A wider lookback gives winners room. _Note: the EMA9/triple-stack gate stays — skip-log review showed it filters flat-EMA chop entries rather than causing them; the churn came from the tight trail, not the entry gate._

### Feature: ORB continuous profit trail (stops winners round-tripping to a loss)

- **ORB now has a continuous peak-giveback trail** (`ORB_TRAIL_ENABLED`, default off, enabled in `.env`). Once the option is `ORB_TRAIL_ARM_PCT` (+8%) in profit, the premium SL ratchets up behind the running peak to always retain `ORB_TRAIL_LOCK_PCT` (50%) of the highest profit seen — so a winner that peaks at +12% can't drift all the way back to flat or a loss.
- This fixes the gap where the old one-shot lock-in only armed at +25% premium, which real ORB trades rarely reach (recent winners peaked +7–13%), so it never fired and the entire unrealized gain was given back. Example: 17-Jun CE peaked +₹1,511 then squared off flat at −₹28; with the trail it would have exited around the locked floor instead.
- Wired identically across paper (canonical), live, and backtest; three keys exposed in Settings. The one-shot lock-in keys remain for backward compatibility; the continuous trail supersedes them when on.

### Feature: one-click "Download Everything" on Trade Logs

- **Trade Logs now has a single Download Everything (all strategies) button** above the per-mode sections on both the **Trade Files** and **Skip Logs** tabs, alongside the existing per-mode **Download All**. They hit `GET /trade-logs/download-everything` and `GET /trade-logs/skips/download-everything`, which concatenate every mode's daily JSONL files (grouped by mode, oldest first) into one `all_strategies_paper_trades_ALL_<date>.txt` / `all_strategies_paper_skips_ALL_<date>.txt`.
- The merged file stays self-describing: each JSONL line already carries its own `mode` field, so records from different strategies remain distinguishable regardless of ordering. No new env keys.

### Fix: deploy chip no longer counts "DEPLOYING" forever

- **The top-right deploy badge could spin "DEPLOYING …" indefinitely.** Deploy state in [deploy.js](src/routes/deploy.js) is held in memory on the same process the deploy restarts; GitHub's `completed` webhook is delivered right as `pm2 startOrRestart` recycles that process, so it routinely lands in the restart window and is lost — the fresh process never flips `deploying` → `success`, even though Actions shows the run finished.
- **Self-heal added.** `/deploy/status` now resolves any deploy that's been "deploying" longer than 3 min (real runs are ~25–90s) to `success`. Sound because the server is up enough to serve the status request, so a deploy that started that long ago must have finished. The `completed` webhook still wins when it arrives; this is the fallback.
- **Green "DEPLOYED Ns ago" chip no longer counts up forever.** The sidebar re-showed the chip and reset its own hide timer on every poll, so a `success` state never disappeared. The endpoint now expires a finished success chip to `idle` ~1 min after it completes, so it flashes briefly then hides. (Failures stay sticky until the next deploy.)

### Fix: consolidated EOD Telegram report now survives post-close restarts

- **The 15:32 IST combined day report no longer silently disappears when the server is restarted after market close.** The old [consolidatedEodReporter.js](src/utils/consolidatedEodReporter.js) was a pure in-memory `setTimeout` that only fired "going forward" — so any redeploy/restart after 15:32 (routine, given push-to-main auto-deploys PM2) rescheduled for *tomorrow* and dropped today's report.
- **Now restart-safe with catch-up + per-day idempotency.** A persisted last-sent date at `~/trading-data/.eod_report_state.json` gates the send. On boot (and on every scheduled tick) the report goes out immediately if it's a trading day, now is ≥ 15:32 IST, and today hasn't been sent yet. The date is recorded only on an actual dispatch (`notifyConsolidatedDayReport` now returns whether it sent), so a gated-off toggle or transient failure is retried on the next boot rather than being marked done.
- No new env keys; gating is unchanged (`TG_ENABLED` + `TG_DAYREPORT_CONSOLIDATED`).

### Feature: OI + Price Buildup entry filter (per-strategy, default OFF)

- **New directional entry gate that blocks trades fighting the Open-Interest buildup.** New service [oiFilter.js](src/services/oiFilter.js) (mirrors `vixFilter.js`) reads NIFTY current-expiry **futures OI** (via `fyers.getQuotes`) against spot over a short lookback, classifies the classic four-quadrant regime, and blocks **CE in a SHORT_BUILDUP** (price↓ + OI↑) and **PE in a LONG_BUILDUP** (price↑ + OI↑). Weak (short-covering / long-unwinding), neutral, warmup, and OI-missing all **fail open**.
- **Wiring.** Gate inserted right after the VIX check in the four directional paper routes — [scalpPaper.js](src/routes/scalpPaper.js), [paPaper.js](src/routes/paPaper.js), [swingPaper.js](src/routes/swingPaper.js) (both candle-close and intra-tick entry paths — the intra-tick path uses a synchronous cached `checkCachedOi` so the tick handler stays non-blocking), [orbPaper.js](src/routes/orbPaper.js) — with a per-candle background OI sample so the buildup series stays filled. **Straddle excluded** (delta-neutral CE+PE pair has no directional side).
- **Logged in every trade.** Entered trades record `oiAtEntry` + `oiRegime` and the regime is appended to `entryReason`; blocked entries go to the skip log under `gate:"oi"` with `oi`/`deltaOi`/`regime`.
- **Replay-safe.** OI is not recorded in tick files, so the filter is **live/paper only** — there is deliberately no backtest path and no `*Backtest.js`/`replay.js` file imports `oiFilter`. Tick-replay drives the paper routes, but its harness stubs `fyers.getQuotes`, so any OI fetch during replay returns no-data and the gate fails open — existing recordings stay valid. (The routes' `!_simMode` guards are for the in-process `/sim` synthetic tester.)
- **Settings.** Dedicated **Open-Interest Filter** section with a **master toggle** (`OI_FILTER_ENABLED`) plus per-strategy toggles (`SWING_/SCALP_/PA_/ORB_OI_ENABLED`), `OI_LOOKBACK_CANDLES` (3), `OI_MIN_DELTA_PCT` (1), `OI_FAIL_MODE` (open) — all INSTANT, default OFF, snapshotted into each mode's daily JSONL. README env table updated.
- ⚠️ The Fyers futures-quote OI field name (`oi`) should be confirmed against a live payload before relying on blocks; the filter fails open if OI is absent.

### Feature: Edge Analytics page (`/edge-analytics`)

- **New read-only analytics dashboard that turns the trades you already record into edge metrics** — no new data is written, it just reads the same per-strategy session files as `/consolidation` (paper) and `/live-consolidation` (live), flattens them to one trade array, embeds it in the page, and computes everything client-side so the **Book (Paper/Live) · Strategy · Date-range (7D / 30D / This FY / custom)** filters recompute instantly with no server round-trip.
- **What it shows.** Eight headline cards — Trades (W/L/BE), Win Rate, Net P&L, Expectancy (₹/trade), Profit Factor (gross win ÷ gross loss), Avg Win / Avg Loss + payoff ratio, Max Drawdown (peak-to-trough on the equity curve), and Win/Loss Streaks. Below: an **equity curve** (cumulative net P&L, trade-by-trade), a **P&L-by-hour-of-day** bar chart (which entry hours actually make money) and a **P&L-by-weekday** bar chart, plus **By Strategy** and **By Exit Reason** breakdown tables (exit reasons sorted worst-net first to surface where the bleed comes from). Bars/values are green/red by sign; hover tooltips add trade count + win rate per bucket. Charts via the same Chart.js 4.4.7 CDN the other analytics pages use; theme-aware (dark/light).
- **Wiring.** New router [edgeAnalytics.js](src/routes/edgeAnalytics.js) mounted at `/edge-analytics` in [app.js](src/app.js); sidebar entry added to [sharedNav.js](src/utils/sharedNav.js) next to the history menus, gated by **`UI_SHOW_EDGE_ANALYTICS`** (default ON), with the matching **Show Edge Analytics** toggle in Settings → Menu Visibility. Hour bucketing handles both the `"HH:MM, DD/MM/YYYY"` (IST) and ISO (UTC→+5:30) entry-time formats the strategies emit. README routes + UI-visibility tables updated.

### Swing: strip Parabolic SAR, make SuperTrend the only trend source, add EMA9>EMA20>EMA50 triple-stack (dormant)

- **Removed Parabolic SAR from Swing entirely.** It was already dead in the live config (SuperTrend was the trend gate, EMA21 the SL), surviving only as an unused entry option, an unused SL-mode, and passive log/record/chart fields. Analysis of 48 paper trades (01–12 Jun) confirmed it had no role — and would have *blocked* the three biggest winners (SAR disagreed with the correct SuperTrend call). `calcSAR()`, the `SWING_USE_SUPERTREND` toggle and the `SWING_SL_MODE=psar` option are deleted; **SuperTrend(10,3) is now the only directional gate and EMA21 the only base SL** (+ optional candle trail). Mirrored identically across the shared signal module ([strategy1_sar_ema_rsi.js](src/strategies/strategy1_sar_ema_rsi.js)), paper ([swingPaper.js](src/routes/swingPaper.js), canonical), live ([swingLive.js](src/routes/swingLive.js)) and backtest ([backtestEngine.js](src/services/backtestEngine.js)); the `sar*` trade-record columns and chart SAR overlay are removed. Scalp's own PSAR is untouched.
- **Added an opt-in EMA triple-stack gate (`SWING_EMA_TRIPLE_STACK_ENABLED`, default OFF + `SWING_EMA_FASTEST=9`).** When ON, the EMA alignment requires EMA9 > EMA20 > EMA50 (CE) / reverse (PE) instead of the 2-EMA cross — a stricter gate that drops the marginal near-flat cross-over entries that drove the chop losses (e.g. a 0.02-pt "cross" that lost −₹2,567). Lives in the shared `getSignal()`, so it applies to backtest/paper/replay/live/harness at once; `ema9AtEntry`/`ema9AtExit` are captured per trade when ON. **Ships dormant** — no behaviour change and the `/replay` baseline stays exact until you enable it. A/B it via `/replay` sim mode on recorded sessions before turning it on for paper/live.
- Settings → Swing updated: section title → **EMA 20/50 + RSI + SuperTrend**; new **Triple-Stack EMA (9>20>50)** toggle + **EMA Fastest Period**; the **Use SuperTrend (vs PSAR)** toggle and **SL / Trail Source** select are gone (SuperTrend + EMA21 are now fixed).

### Settings: expose `SWING_OPTION_EXPIRY_TYPE` in Swing section

- **Surfaced the swing-only expiry type toggle (`weekly`/`monthly`) in Settings**, sitting next to the existing **Swing Option Expiry (override)** field — mirroring how the common section pairs `OPTION_EXPIRY_OVERRIDE` with `OPTION_EXPIRY_TYPE`. The key was already read by `src/config/instrument.js` (per-mode `${MODE}_OPTION_EXPIRY_TYPE`) but had no UI control; blank inherits the common Expiry Type.

### Feature: Swing choppy-day guard (`SWING_MAX_CONSEC_LOSSES`)

- **Added a consecutive-loss circuit breaker that sits Swing out for the rest of a choppy session.** After `SWING_MAX_CONSEC_LOSSES` losing trades in a row, new Swing entries are blocked until the session ends (or, in backtest, until the next trading day). Any **winning** trade resets the streak to 0 — so a day that chops early then trends is not permanently locked out. This targets range days where SuperTrend keeps flipping and the strategy dies by small stops, re-entering after each tiny loss (e.g. a −71/−71/−71/−133/−584 bleed → halt after 3 saves the tail).
- **Keyed on realized P&L sign, not exit reason** — a "Trail SL hit" can be a winner, so the streak counts `netPnl < 0` and resets on `netPnl > 0`. It uses an independent counter (`_chopConsecLosses`), separate from the legacy 3-loss escalating *pause* (which resets itself to 0 on 5-min and would otherwise make a count-based guard never fire).
- **Off by default (`0`)** — no behaviour change until set. Wired consistently into paper ([swingPaper.js](src/routes/swingPaper.js), canonical + drives `/replay`) at both entry gates, live ([swingLive.js](src/routes/swingLive.js)) at both entry gates, and the backtest engine ([backtestEngine.js](src/services/backtestEngine.js)). Counter resets at session start (paper/live) and per trading day (backtest). Exposed in Settings → Swing as **Chop Guard (consec losses)** (INSTANT — no restart). Validate a value via `/replay` before running it live.

### Feature: Swing per-trade points stop (`SWING_STOP_LOSS_PTS`)

- **Added a spot-points catastrophic loss cap to Swing, mirroring `SCALP_STOP_LOSS_PTS`.** Exit once spot moves `SWING_STOP_LOSS_PTS` against entry. It's checked **before** the structural/trail SL, so it caps deep adverse excursions on trades whose prevHigh/prevLow stop sits wider than the cap (Swing's initial stop is often 40–70 pts away, so a loosely-trailed loser could bleed past the cap before the trail fired). Points-based, so it behaves identically on spot-proxy replays.
- **Off by default (`0`)** — no behaviour change until set. Wired consistently into paper ([swingPaper.js](src/routes/swingPaper.js), canonical + drives `/replay`), live ([swingLive.js](src/routes/swingLive.js)), and the backtest engine ([backtestEngine.js](src/services/backtestEngine.js), folded into Rule 1 as the tighter-of-two stop). Exit reason: `SL (Npts)`. Arms the same-side SL cooldown like other SL hits. Exposed in Settings → Swing as **Stop Loss (pts)** (INSTANT — no restart). Validate a value via `/replay` before running it live.

### Feature: Strategy guides show a live "as-per-settings" status panel

- **Each strategy guide (Docs → Documents) now opens with a "Live Configuration" panel that reflects this server's current Settings.** The documented **Default** columns in the tables below are unchanged — the new panel adds a per-feature **ENABLED / DISABLED** badge showing what's actually active right now (e.g. VIX filter, wick/VWAP/volume filters, premium gate, expiry-day-only, candle trail, ADX filter, per-strategy mode toggle). Live Orders renders as a tri-state: **DISABLED → DRY-RUN → LIVE · REAL ORDERS** (honouring the global `LIVE_HARNESS_DRY_RUN` kill-switch and each strategy's own `*_LIVE_DRY_RUN` override). The Application Setup guide gets a system panel (global gates + all five strategy master toggles).
- **How it works.** Each guide HTML carries a `<!--LIVE_STATUS_PANEL-->` marker; [docs.js](src/routes/docs.js) replaces it at serve-time, resolving each toggle from the live runtime config (`process.env`, kept in sync with `.env` by Settings) with the documented default as fallback — the same resolution the strategy code uses. Files without the marker (e.g. PDFs) are served unchanged. No new env keys or routes; the panel is regenerated on every page load, so it always matches Settings.

### Fix: Charges schedule corrected to current NSE / statutory rates (matches Zerodha)

- **Options exchange-transaction charge was 0.05%; the current NSE rate is 0.03553% of premium turnover.** This single stale rate (plus its 18% GST knock-on) was inflating every option trade's modelled charges — e.g. a 4-trade Swing session billed ₹336.06 vs Zerodha's ₹317.21. Corrected the default in [charges.js](src/utils/charges.js), [settings.js](src/routes/settings.js), and [README.md](README.md). Futures exchange txn likewise corrected 0.002% → 0.00183%.
- **GST base now includes SEBI charges** (`18% × (brokerage + exchange txn + SEBI)`), per the exchange schedule — previously SEBI was omitted from the GST base.
- **Exchange txn is no longer broker-specific.** It's an NSE charge, identical for every broker, so the hard-coded Fyers override (0.0445%) was removed — Scalp / PA / ORB / Straddle now use the same env-driven NSE rate as Swing. STT (0.15% options / 0.05% futures), SEBI (₹10/cr), stamp duty (0.003%) and flat brokerage (₹20/order) were already correct and are unchanged.
- **Contract-note report now derives gross from the trade prices** (`gross = (sell − buy) × qty`) and `net = gross − charges`, the way a broker contract note does — instead of reading back the stored net and adding charges. This keeps the Gross column and the charges breakdown self-consistent after a rate change and makes the note match Zerodha's calculator exactly. For a trade booked at the current rates this net equals the stored P&L; trades booked **before** this fix keep their stored (higher-charge) dashboard P&L, so the note will read slightly better than the dashboard for those — re-run via `/replay` in current-settings mode to see them fully recomputed.
- **Note:** these are *defaults*. If a value for any of these keys is already persisted in the server environment (from a prior Settings save), update it in Settings → Charges so the new rate takes effect.

### Fix: Responsive layout on 13" laptops (Dashboard login button + Settings values)

- **Dashboard cards (broker connections, strategy charts) were cut off on the right on narrower desktops (e.g. 13" MacBook ~1440px), hiding the broker Login buttons.** Root cause: `.main-content` is a flex item but only got `min-width:0` inside the mobile (`≤768px`) block. On every wider screen it kept the flex default `min-width:auto`, so it **grew wider than the viewport** to fit its widest multi-column grid, and `body{overflow-x:hidden}` clipped the overflowing right edge (unreachable — couldn't even scroll to it). Zooming out only appeared to help because it shrank everything below the overflow point.
- **Fix.** Added `min-width:0` to the base `.main-content` rule in [sharedNav.js](src/utils/sharedNav.js) so the content column stays pinned to the viewport width on all pages and the inner responsive grids reflow instead of overflowing. Also made the dashboard grid items (`.mm-grid`/`.da-grid`/`.ts-grid` children) shrink-safe, and added a laptop/small-desktop breakpoint (`≤1200px`) that stacks the broker + strategy rows and wraps `.brk-row` so the login button drops to its own line ([app.js](src/app.js)). On Settings the `pattern-grid` collapses to one column and inputs get more room ([settings.js](src/routes/settings.js)). The 32" monitor and phone layouts are unchanged. CSS only — no env keys or routes.

### Feature: Contract-note Report (gross / charges breakdown / net P&L) on History + Replay

- **New "📄 Report" button on every Paper Trade History page (Scalp / Swing / ORB, plus PA / Straddle).** It opens a broker-style **contract note** in a popup: a per-trade table (segment · exchange · buy price · sell price · qty · gross profit), then **Total gross profit / Total charges / Net P&L**, then a **Charges breakdown** (Brokerage, Exchange txn charge, Stamp duty, STT, GST, SEBI). Two scopes: a per-day **Report** button on each session card, and a top-bar **Report** button for all sessions combined.
- **Same Report on the Replay page** — a per-session **Report** under each replayed session's trades, a **Report (all)** button covering the whole range run, and a Report on the single-session result.
- **Export PDF** — the popup has an Export PDF button that opens a clean print view (Save as PDF) of the contract note.
- **Numbers match the dashboard.** Charges use the same canonical `calcCharges()` the engines use (broker schedule per strategy — Swing = Zerodha rates, others = Fyers), and **Net P&L is anchored to the stored trade P&L**, so the report total equals the P&L shown everywhere; gross is derived as `net + charges`. Slippage / bid-ask spread is not modelled (same as paper/live). New shared module [contractNote.js](src/utils/contractNote.js); wired through [paperHistoryUI.js](src/utils/paperHistoryUI.js) and [replay.js](src/routes/replay.js). No new env keys or routes — the note is built client-side from data already on the page.

### Change: Scalp — BB re-entry stop is now per-tick (band touch), not candle-close

- **BB re-entry exits the instant spot crosses back through the band.** The `SCALP_BB_REENTRY_EXIT` stop previously only evaluated on 5-min candle **close** (`close > BB.lower` for PE / `close < BB.upper` for CE). On a one-candle V-reversal that let the bar print far past the band before exiting — e.g. the 2026-06-03 12:05 PE gave back to a 23236 close (−65.75 spot pts) when the band sat near 23195. The stop is now checked **per-tick** against the band fixed at the bar's start (from completed candles), so it exits at the band line. Applies to Scalp **paper + live** (canonical paper logic); **backtest** mirrors it via the bar's adverse extreme vs the band, exiting at the band level (profit-lock still takes priority within a bar). Same `SCALP_BB_REENTRY_EXIT` gate (default on); the candle-close check is kept as a backstop. New helper `bbLevels()` in [scalp_bb_cpr.js](src/strategies/scalp_bb_cpr.js).
- **Arming guard so a fresh entry at the band isn't whipsawed out.** The per-tick exit above can stop a trade taken right at the band on an immediate noise wick — on 2026-06-03 it flipped the 10:15 PE from a +₹445 profit-lock winner to a −₹376 loss by exiting 27s after entry (entered only 8 pts below the band). The exit now **arms only once the breakout has extended ≥ `SCALP_BB_REENTRY_ARM_PTS(10)` past the band** (tracks max favourable penetration per position); before that, band touches are ignored. The 12:05 protection is unaffected (it was 30+ pts past the band, armed immediately). On the recorded 2026-06-03 session this keeps the 12:05 save while restoring the 10:15 winner. New env key `SCALP_BB_REENTRY_ARM_PTS` (Settings → Scalp; `0` = arm immediately, i.e. old behaviour).
- **Scalp chart hover time fixed.** The crosshair time label defaulted to UTC (a 12:25 IST bar showed `06:55`). Added `localization.timeFormatter` to the scalp-paper chart so the hover time matches the IST axis, mirroring the fix already in [replay.js](src/routes/replay.js). The same UTC-crosshair bug still exists in the other chart routes (swing/PA/ORB/straddle paper+live) — not yet patched.

### Change: Dashboard — hide controls & broker cards while a trade is running

- **Distraction-free Dashboard during active trading.** While any strategy is running (paper or live), the Dashboard now hides the top-bar action buttons (Start All (Harness) / Start All (Paper) / Reset Token), the schedule/cache pills (Expiry / Holiday / Candle cache), and the Fyers/Zerodha broker connection cards (balance, status, Login buttons). These reappear once everything is idle.
- **Always-on running indicator.** A status badge stays visible while active — the existing mode-specific badges (LIVE ACTIVE / SCALP LIVE / PA LIVE / ORB PAPER / STRADDLE PAPER) plus a new generic **TRADE ACTIVE** badge that covers the remaining states (Swing/Scalp/PA paper, ORB/Straddle live) so you always know a trade is on.

### Change: Price Action — retest-confirmation entry, SL cap restored, pattern drawn on chart

- **Retest entry (kills false breakouts).** A breakout no longer enters on the breakout candle. It's parked as *pending* and only fires when price pulls back to the broken level and closes back on the breakout side (a retest), within `PA_RETEST_MAX_WAIT=4` candles and `PA_RETEST_TOL_PTS=10`. If price closes back through the level, the breakout is discarded. Replay diagnostic over 8 sessions showed ~23% WR from raw-breakout entries (breakout-then-instant-reversal) — this targets that leak. All internal knobs (no Settings rows).
- **SL cap restored (internal).** Structural SL is clamped to `[PA_MIN_SL_PTS=8, PA_MAX_SL_PTS=25]` again — the uncapped version was producing −40 to −58 pt losers on failed breakouts. Still computed internally (not Settings knobs).
- **Pattern drawn on the chart (paper / live / replay).** The detector now returns the pattern's anchor points (twin tops/bottoms, triangle pivots) and neckline. The chart shows them as yellow labelled dots (Top1/Bottom1/R1…) plus a dashed **Neckline** line, so the W / M / triangle is actually visible — alongside the existing Entry/SL lines and entry/exit arrows. Persisted per-trade so replayed sessions render each trade's pattern.

### Change: Price Action — structural SL (no clamp) + settings declutter

- **SL is now purely structural — no min/max clamp.** The stop sits at the pattern's invalidation level (just below the twin bottoms / rising-low support for CE; just above the twin tops / falling-high resistance for PE) with a small internal buffer. Removed the `[PA_MIN_SL_PTS, PA_MAX_SL_PTS]` clamp from the engine **and** the duplicate re-clamp in paPaper/paLive auto-entry — the engine's structural SL is now used verbatim. (Manual-entry button still uses the prev-candle SL with hidden defaults.) Note: stops can be wider than before on tall patterns — this is intentional, matching the chart playbook.
- **Settings decluttered.** Detection internals (`PA_MIN_BODY`, `PA_CHART_PATTERN_TOL`, `PA_SR_LOOKBACK`) and SL placement (`PA_SL_BUFFER_PTS`, `PA_MAX_SL_PTS`, `PA_MIN_SL_PTS`) are now computed internally and removed from the Settings UI (code keeps the defaults; still `.env`/Bulk-Edit overridable). PA page now shows only the knobs you actually tune.
- **Chart clarity (paper / live / replay).** Entry + exit are drawn on all three: entry arrow (with a clean `CE DblBot @23050`-style label, dead pattern/RSI tokens removed), exit arrow with P&L, plus dashed **SL** and dotted **Entry** price lines. Replay reuses the paper chart-data endpoint, so it shows the same. The SL line now reflects the true structural stop.

### Change: Price Action — strip RSI/ADX confluence + dead knobs (pure chart-pattern entries)

- **RSI + ADX gates removed.** Per the chart-pattern playbook (the images use pure price structure), PA no longer applies any RSI or ADX confluence. Entry = the pattern breakout candle, gated only by `PA_MIN_BODY`. Deleted from `price_action.js`: RSI calc + cache, ADX calc, the chop gate, and all RSI/ADX entry conditions. Removed settings: `PA_RSI_PERIOD/CE_MIN/CAPS_ENABLED/CE_MAX/PE_MAX/PE_MIN`, `PA_ADX_ENABLED/MIN`.
- **Dead/zombie knobs removed.** `PA_VIX_STRONG_ONLY` (inert — all patterns are STRONG) and `PA_OPT_STOP_PCT` (display-only — it powered an "Option SL" readout on the live page but never triggered an exit) are gone from Settings; the misleading "Option SL" card was removed from the PA Live page. `PA_LIVE_DRY_RUN` was kept (it IS read, dynamically, via `liveDryRun.isDryRun`).
- Net: the PA Settings page drops ~10 rows. Focus paths (paper / live / replay) verified loading + signalling clean.

### Change: Price Action rebuilt — 4 chart patterns only, structural SL + breakeven→swing trail

- **Patterns cut to four.** Engulfing, Pin Bar, Inside Bar and Break-of-Structure are **removed** from `price_action.js`. PA now fires on exactly four chart patterns, all **ON by default**: **Double Bottom (W) → CE**, **Double Top (M) → PE**, **Ascending Triangle → CE**, **Descending Triangle → PE**. Detection uses the last two swing highs/lows (`PA_SR_LOOKBACK=30`), "equal" levels within `PA_CHART_PATTERN_TOL=12` pts, breakout candle body ≥ `PA_MIN_BODY=5`.
- **Stop-loss now sits at the pattern structure.** SL is placed `PA_SL_BUFFER_PTS=3` beyond the pattern extreme (below the twin bottoms / rising-low support for CE; above the twin tops / falling-high resistance for PE), then clamped to `[PA_MIN_SL_PTS=8, PA_MAX_SL_PTS=25]` (cap raised from 12). The old tight 8–12 pt clamp that overrode structure is gone.
- **Exit = breakeven then swing trail.** Once peak PnL ≥ `PA_BREAKEVEN_TRIGGER=300` (₹), the SL lifts to entry ± `PA_BREAKEVEN_BUFFER=1` pts; from there the swing-structure trail tightens it to each new swing low/high. This **wires the previously-inert** `PA_BREAKEVEN_TRIGGER`/`PA_BREAKEVEN_BUFFER` knobs. The candle-trail, tiered profit-lock floor, and PA time-stop are **removed** (paper / live / backtest aligned).
- **Settings cleaned.** Dropped `PA_PATTERN_ENGULFING/PINBAR/BOS/INSIDE_BAR`, `PA_PIN_WICK_RATIO`, `PA_MAX_STRUCT_SL_PTS`, `PA_ADX_RISING_REQUIRED`, `PA_SR_ZONE_PTS`, `PA_CANDLE_TRAIL_*`, `PA_TRAIL_START/PCT/TIERS`, `PA_TIME_STOP_*`. Added `PA_SL_BUFFER_PTS`; surfaced `PA_CHART_PATTERN_TOL`. Pattern-Test page (`/pa-pattern-backtest`) now shows the four panels only.
- Historical trade logs that contain the old pattern names still render correctly in the PA history view (display-side classifiers retained).

### Change: Live harnesses now run in parallel + event log survives restart

- **Multiple harnesses at once.** The live harness was a process-wide singleton — only one strategy's harness could be installed at a time, so "Start All (Harness)" actually installed Swing and then **409'd Scalp + ORB** ("already installed"). The harness is now a per-mode registry: each strategy registers its own `notify` order hooks keyed by mode and filters payloads by its `modeTag`, so Swing / Scalp / ORB / PA harnesses run **concurrently without colliding**. Re-installing the *same* mode still throws. (`notify.js` now holds a `Map` of hook-sets instead of a single pair.)
- **Harness event log persists across restarts.** The "Recent harness events" ring buffer is now written to `~/trading-data/.harness_events.json` (debounced) and reloaded on boot, so a deploy / PM2 restart no longer wipes it to `[]`. Events are tagged with their mode; each harness's status panel shows only its own events.

### Change: Swing SL — breakeven removed, candle-trail overlay added, `candle` mode dropped

- **Breakeven removed.** `BREAKEVEN_PTS` is gone from the Swing settings page and from all three engines (paper / live / backtest). It was inert in `ema`/`psar` mode anyway (only ran in the old `candle` mode), so removing it changes nothing for current `ema`-mode sessions.
- **`SWING_SL_MODE` now `ema | psar`** (was `candle | psar | ema`, default `candle`). New default is **`ema`** — the trail follows EMA21 and a candle touching back EMA21 is an explicit exit; `psar` trails Parabolic SAR with a flip-exit.
- **New optional candle-trail overlay** (`SWING_CANDLE_TRAIL_ENABLED`, default **OFF**, + `SWING_CANDLE_TRAIL_BARS`, default 2). When ON, each candle close the stop is set to whichever is **tighter** (closer to price) — the EMA/PSAR line or the N-bar low (CE) / high (PE). It can only pull the stop closer (banks more of a winner), never loosens it. Both keys are INSTANT (read live from `process.env`, no restart). Mirrors PA's `PA_CANDLE_TRAIL_*`.
- **Dead key removed:** `SWING_OPTION_EXPIRY_TYPE` (nothing read it) is dropped from the Settings UI.
- UI trail card + start-logs now show the active trail source (e.g. `EMA21 + 2-bar low`) instead of the old "Prev-candle low / Breakeven+" text.

### Fix: Scalp backtest enters on the signal bar's close (matches paper)

- **Bug:** the scalp backtest queued each signal and entered on the **next candle's open**, while paper (the canonical engine) enters immediately at the **signal bar's close**. That one-bar shift moved every stop-loss reference, which changed which trades hit Profit-lock vs BB-re-entry, which changed the re-entries after them — so the backtest's trade list diverged from paper's for the same day/settings.
- **Fix:** the backtest now creates the position at `candle.close` on the bar the signal fires (same as `scalpPaper.onCandleClose` → enter at `bar.close`); the `pendingSignal` / next-bar-open machinery is removed. Trade *entries* now line up with paper. **Note:** rupee P&L still won't match paper exactly — the backtest has only spot candles, so it prices options synthetically (`δ=0.55, θ=₹10/day`) and approximates the per-tick exits with bar high/low. For tick-accurate reproduction of a recorded paper session, use **Replay**.

### Change: Settings-changes history capped at 3 days

- **Settings audit retention:** the **Trade Logs → Checkpoints & Settings Changes** tab (`settings-audit.jsonl`) now keeps only the **last 3 days** of changes (`SETTINGS_AUDIT_RETAIN_DAYS=3`). Older entries are pruned from the file on every settings save and are never returned/shown — the list was growing unbounded (458 rows). No effect on per-day trade JSONL checkpoints.

### Feature: Dashboard "Start All (Harness)" one-click button

- New top-bar button (left of **Start All (Paper)**) that starts every Live (Harness) mode in one click — Swing + Scalp + ORB (each gated by its `*_MODE_ENABLED`). Fires the `*-live-harness/start` routes, which wrap Paper so **LIVE = PAPER by construction** and respect the global `LIVE_HARNESS_DRY_RUN` flag (no real orders while DRY-RUN is on). Avoids visiting each strategy's Live (Harness) page separately. The existing **Start All (Live)** button still fires the legacy standalone `*-live` engines.

### Fix: Swing + Scalp skip pre-market/pre-open candles (SuperTrend/SAR now match Kite)

- **Bug:** the tick→candle builders created candles from **pre-market ticks** — flat filler bars (~08:25–09:10) plus the **09:00 pre-open auction bar** (a wild wide-range print, e.g. a 250-pt range with a junk low). These polluted the path-dependent indicators (SuperTrend, SAR): the pre-open bar flipped SuperTrend bullish at 09:00 and pinned the support band a few points too high, causing a **premature bearish flip at 09:40** when the real flip (per Kite/TradingView) was ~11:45. Once flipped, the bot stayed on the wrong trend all midday.
- **Fix (candle hygiene):**
  - **Tick builders** now **only build candles from 09:15 IST** (NSE regular-session open), gated on the candle bucket's own IST time so it's correct in live **and** replay/sim. Applied to **Swing** (paper + live, fixed `_MKT_OPEN_MINS`) and **Scalp** (paper + live, via shared `isPreMarketBucket()` in `tradeUtils`). Swing/Scalp replay also benefit (recorded ticks re-run through the fixed builder).
  - **Historical fetch** (`backtestEngine.fetchCandles`) now filters to regular session (09:15 ≤ IST < 15:30), so the **warmup preload + backtest** candle sets are consistent with the live chart. Defensive no-op when the feed is already 09:15+.
- Verified the bot's SuperTrend formula + Wilder ATR already match TradingView/Kite exactly — same candles in → same SuperTrend out; the divergence was purely the extra pre-open candles.
- **PA / ORB / Straddle** tick builders still ingest pre-market candles (same latent issue) — left unchanged for now since they don't use SuperTrend and ORB's opening range is candle-boundary sensitive. The shared `isPreMarketBucket()` gate can be dropped into their `onTick` if wanted.

### Swing entry redefined to EMA20/EMA50 crossover gate + SuperTrend line coloured green/red

- **Swing entry is now an EMA20-vs-EMA50 alignment gate** (close-based, periods via new `SWING_EMA_FAST`=20 / `SWING_EMA_SLOW`=50). Entry fires only when **all 3** are true:
  - **CE**: EMA20 **above** EMA50 · RSI(14) in the CE band (`RSI_CE_MIN`..`RSI_CE_MAX`) · trend source **GREEN** (SAR below price, or SuperTrend bullish when `SWING_USE_SUPERTREND=true`).
  - **PE**: EMA20 **below** EMA50 · RSI in the PE band · trend source **RED**.
  - This **replaces** the old "price touches EMA21" gate and **removes** `SWING_ENTRY_REQUIRE_CROSS` / `SWING_ENTRY_CROSS_TOLERANCE` (obsolete). **Stop-loss is unchanged** (prev-candle low/high, trailed). `EMA21(OHLC4)` is still computed for the `ema` SL mode + the trade-record snapshot, but is no longer an entry input.
- **Chart**: the Swing chart now draws **EMA20 (gold) + EMA50 (blue)** lines (was a single EMA21). EMA20/EMA50 values are recorded per trade in the JSON + daily JSONL (`ema20AtEntry`/`ema50AtEntry`/`ema20AtExit`/`ema50AtExit`).
- **SuperTrend line is now trend-coloured GREEN (bullish) / RED (bearish)** on the Swing, Scalp **and** Replay charts (was solid amber). The chart-data payload carries `trend` per SuperTrend point and the client colours each segment accordingly.
- **Scalp entry already honoured `SCALP_USE_SUPERTREND`** (PSAR vs SuperTrend) in paper/live/backtest — no logic change; only the chart line colouring was updated.

### SuperTrend(10,3) trend confirmation for Swing & Scalp (toggle vs PSAR) + ADX on Scalp chart

- **New `SWING_USE_SUPERTREND` / `SCALP_USE_SUPERTREND` toggles** (default off → PSAR, current behaviour). When ON, **SuperTrend(10,3)** replaces Parabolic SAR as the directional entry confirmation. The two are **mutually exclusive** — exactly one trend source is active. Period/multiplier configurable via `{SWING,SCALP}_SUPERTREND_PERIOD` (10) / `_MULT` (3). All exposed in the Settings UI under each strategy.
  - **Swing**: SuperTrend swaps SAR's "which side is the trend on?" role; the SL seed (prev-candle low/high) is unchanged.
  - **Scalp**: SuperTrend takes over the directional confirmation, the **entry SL line**, and the **candle-close trend-flip exit** (the `isPSARFlip` exit becomes a unified `isTrendFlip` that follows the active source). Profit-lock / hard-stop / BB-reentry exits unchanged.
  - SuperTrend is built on the `technicalindicators` ATR (the package has no SuperTrend), mirroring how Swing already hand-rolls SAR. New shared helper [src/utils/supertrend.js](src/utils/supertrend.js).
- **Charts now plot the active trend source only** — PSAR dots when PSAR is on, a solid SuperTrend line when SuperTrend is on (Swing + Scalp, paper + live).
- **Scalp chart now shows the ADX subplot** (it was computed only behind the `SCALP_ADX_ENABLED` filter and never charted). ADX(14) is now computed every candle and drawn on its own pane with the `SCALP_ADX_MIN` floor line.
- **Trade logs now capture all indicator values at entry AND exit** — added `supertrendAtEntry/Exit`, `stTrendAtEntry/Exit`, `trendSource` (Swing + Scalp) and `adxAtEntry/Exit` (Scalp), plus an at-exit indicator snapshot (RSI/EMA21/SAR/BB/SuperTrend) recomputed on close.
- **Replay chart now renders SuperTrend + ADX too.** The Replay page reuses each strategy's `/status/chart-data` (so the payload already carried `supertrend`/`adx`), but its chart renderer only drew SAR/EMA/BB/RSI — it now draws the SuperTrend line and the ADX subplot, and the diagnostic trace switches its label to SuperTrend when that was the active source.

### Live (Harness) for Swing, Scalp & ORB + interception fix

- **New `/swing-live-harness`, `/scalp-live-harness`, `/orb-live-harness` routes** — each runs LIVE by wrapping its Paper engine (LIVE = PAPER by construction), mirroring the existing PA harness. Swing routes orders via Zerodha; Scalp/ORB via Fyers. Gated by `LIVE_HARNESS_DRY_RUN` (+ per-strategy `{SWING,SCALP,ORB}_LIVE_DRY_RUN`) and shown via `UI_SHOW_{SWING,SCALP,ORB}_LIVE_HARNESS` (default off). Only one harness can be installed at a time (process-wide lock).
- **Fixed live-harness order interception.** The harness reassigned `notify.notifyEntry/Exit`, but every paper module destructures those at `require` time, so the reassignment never reached them — the order branch was a silent no-op even with `LIVE_HARNESS_DRY_RUN=false`. `notify.js` now invokes registered order hooks from *inside* `notifyEntry/notifyExit` (before any Telegram gating), and `liveHarness` registers via `setOrderHooks`/`clearOrderHooks`. This fixes the PA harness too.
- **Wired Zerodha dispatch** in `liveHarness._placeOrder` (previously threw "not yet wired"), enabling the Swing harness to place real orders.

### Cache Files — per-strategy tags + filtered Delete All

- **Replay groups (Replay Trades / Replay Trades (Sim) / Replay Cache) now show a Strategy badge and Session date per file.** The Replay Cache files are sha1-hash-named, so previously there was no way to tell a SCALP cache from a SWING one — "Delete All" wiped every strategy at once. The badge is derived from the filename for the replay outputs and from the embedded `mode` for hash-named cache files; the session date is read from the cached result (`date`, now stored) or recovered from a numeric `sessionId`.
- **New per-group Strategy filter dropdown.** Selecting e.g. SCALP scopes the listing, the "Download All", and the "Delete All" to just that strategy — so you can clear SCALP caches without touching SWING. The confirm dialog spells out the scope. `tickReplay` now stamps `date` into every cached replay result so future caches are self-describing.

### SCALP — optional ADX trend filter (sit out choppy sessions)

- **New `SCALP_ADX_ENABLED` (toggle, default off) + `SCALP_ADX_MIN` (default 20).** When on, blocks **all** entries on a candle whose `ADX(14)` is below the floor — the engine sits out ranging/chop sessions. **Why:** replay showed the strategy's winning days are clean trends (price marches one way, all-PE or all-CE, big net +) while the losing days are choppy (price flip-flops, a mix of CE+PE that all fail). The entry rule is the same; the difference is trend vs chop. ADX is the standard trend/chop separator, so gating on it skips the bleed days at the source. Ships **off** so it can't change current behaviour until enabled. Engine computes ADX only when the toggle is on. `getSignal` result now carries `adx`. Settings + docs updated.

### SCALP — added a wide points hard stop alongside the profit lock (V6.2.1)

- **New `SCALP_STOP_LOSS_PTS` (default 30) — a per-tick catastrophic loss cap.** Exits if the trade moves N spot points against entry. Set **wide** so it never touches the normal small scalps; it only clips the deep adverse excursions on failed BB-break fades that previously bled to −100+ pts before the candle-close BB re-entry / PSAR flip could fire (the −₹1.9K/−₹2.4K losers). Points-based; reason `SL (Npts)`; arms the per-side SL cooldown. The profit lock (upside) and BB re-entry / PSAR flip are unchanged. Engine adds `hardStop()`; applied across paper/live/backtest/replay.
- **Note:** an earlier attempt (V6.3) that *replaced* the profit lock with a fixed-points trailing stop + a tight −20 hard stop was reverted — it was asymmetric (winners cut to breakeven, losers took the full stop). This change keeps the winning V6.2 behaviour and only caps the tail.

### SCALP — profit lock switched to spot-POINTS (V6.2)

- **Profit lock is now points-based, not ₹-based.** It tracks the favourable spot move since entry (PE = entry−price, CE = price−entry): once the peak favourable move ≥ `SCALP_PROFIT_LOCK_TRIGGER_PTS` (default 25), it exits when the move gives back below `SCALP_PROFIT_LOCK_PCT`% of the peak (ratchets up: peak 100pts → lock 50pts). **Why:** the old ₹-based lock (a) exited far too early on tiny ₹ peaks, and (b) read option P&L that is *fake* on spot-proxy replay sessions (a PE that fell 89 pts could show −₹68), so it never locked the real move. Points are real even on those sessions. Renamed key `SCALP_PROFIT_LOCK_TRIGGER` (₹) → `SCALP_PROFIT_LOCK_TRIGGER_PTS` (points). Exit label is now `Profit lock (Npts)`. Applied across paper/live/backtest.

### SCALP — BB re-entry (failed-breakout) exit (V6.1)

- **New candle-close exit: `SCALP_BB_REENTRY_EXIT` (default on).** After entry, if a candle closes **back inside** the Bollinger Band the breakout that triggered the trade has failed → exit immediately, rather than waiting for the slower PSAR flip. CE exits when `close < BB.upper`; PE exits when `close > BB.lower`. Targets the loss-bleed seen on replay (05-29 PE −₹3,236, 05-21 PE −₹1,455, 05-26 PE −₹1,695 all reversed back into the band before the PSAR flip fired). Order on candle close: profit lock (per-tick) → BB re-entry → PSAR flip → EOD. Toggleable so it can be A/B'd via `/replay`. Engine helper `scalpStrategy.bbReentryExit(window, side)`; applied across paper/live/backtest.

### SCALP — far-PSAR entry filter + profit lock (V6.1)

- **Profit lock replaces the R-multiple break-even.** The V6 break-even snap (`0.7 × initial risk`) almost never armed, because the no-clamp PSAR SL made "risk" huge (often 100–400 pts) — so winners round-tripped to the candle-close PSAR flip (replay showed a +₹650 peak giving back to −₹1,187). New per-tick **profit lock** works in P&L space: once peak open P&L ≥ `SCALP_PROFIT_LOCK_TRIGGER` (default ₹500), exit when open P&L falls below `SCALP_PROFIT_LOCK_PCT` (default 50) % of peak. The floor ratchets with the peak (peak ₹1000 → lock ₹500, peak ₹2000 → lock ₹1000), banking small scalp profits while letting runners ride to the PSAR flip. Removed `SCALP_BREAKEVEN_TRIGGER_R` / `SCALP_BREAKEVEN_OFFSET_PTS`.
- **Far-PSAR entry filter.** New `SCALP_MAX_ENTRY_SL_PTS` (default 50): skip entries where PSAR sits farther than N pts from close. A freshly-flipped SAR can be 100s of pts away, producing uncapped-risk trades; this bounds entry risk without re-introducing a hard SL clamp.
- Exit reasons are now `Profit lock` / `PSAR flip` / `EOD square-off`. Applied across paper (canonical), live, backtest, replay; SCALP.md / README / docs updated.

### SCALP — simplified RSI entry + PSAR-flip exit (V6)

- **Entry RSI reduced to two keys.** Removed the `SCALP_RSI_CE_MAX` / `SCALP_RSI_PE_MIN` overbought/oversold caps. Entry is now simply CE: `RSI > SCALP_RSI_CE_THRESHOLD` (default raised **62 → 70**); PE: `RSI < SCALP_RSI_PE_THRESHOLD` (default lowered **42 → 40**). BB-break and PSAR-side conditions unchanged.
- **Exit is now PSAR-flip driven.** Initial SL = the PSAR value at entry (no min/max clamp). The position rides until the **PSAR flips on candle close** — that is the only normal exit; there is no intra-tick stop before break-even. The **break-even snap** (`SCALP_BREAKEVEN_TRIGGER_R`, default 0.7R) is retained as the sole hard intra-tick stop, fixed at entry ± offset. EOD square-off and daily-loss / max-trades / SL-pause guards are unchanged.
- **Removed the PSAR trail and prev-candle trail entirely**, along with the `SCALP_SL_USE_SAR`, `SCALP_MAX_SL_PTS`, and `SCALP_MIN_SL_PTS` settings (SL is always the PSAR value). Applied consistently across paper (canonical), live, and backtest. Updated SCALP.md / README.

### HISTORY — per-session "View chart" link into Replay

- **Each session card on all 5 paper history pages (Swing/Scalp/PA/ORB/Straddle) now has a 📈 View chart link** that opens the candlestick chart + EMA/SAR/RSI + entry/exit trade markers for that exact session in Replay — no manual date/mode setup. The link deep-links `/replay?from=…&to=…&mode=…&run=1`; Replay prefills the date range + strategy mode and auto-runs. Reuses the existing Replay rendering (no duplicated chart code). Opens in a new tab.

### SYSTEM — Cache Files browser (`/cache-files`)

- **New System page to inspect, download, and clear every on-disk cache.** Groups each cache by purpose — Backtest Cache, Candle Cache, Recorded Ticks (`data/ticks/` date folders only), Replay Trades (snapshot + sim), Replay Cache, and loose Root Data Files under `~/trading-data/` — with per-file **View** / **Download** / **Delete** and group-level **Download All** (`.tar.gz`) + **Delete All**, mirroring the Trade Logs UX (paging, double-confirm, light-theme). The canonical trade/skip JSONLs stay on `/trade-logs`; cache deletes here are safe (regenerated on demand).
- The replay output/cache dirs (`_replay_trades`, `_replay_trades_sim`, `_replay_cache`) live under the tick ROOT_DIR (`data/ticks/`), so their groups point there and the Recorded Ticks walk skips underscore-prefixed subdirs to avoid double-listing them.
- Read endpoints are open; the two delete endpoints require `API_SECRET`. File access is path-traversal-guarded (resolved path must stay inside the group's base dir). Gated by the new `UI_SHOW_CACHE_FILES` toggle (default on) in Settings → System sub-menus.

### REPLAY — deterministic result cache (faster re-runs)

- **Re-running an identical replay is now near-instant.** A replay is deterministic, so the full result (trades, P&L, chart) is cached on disk in `data/ticks/_replay_cache/` and served on an identical re-run instead of re-streaming ~55k ticks (~80s/session → ~0s). Date-range runs benefit per-session automatically.
- **Cache key** fingerprints everything that can change the outcome: mode, date, session id, the recorded tick-file size+mtime (spot/options/vix/sessions), the replay-code version, and the settings basis — recorded session-start settings in **snapshot** mode, current env (restricted to the snapshot's settings keys, so PM2/deploy-injected vars don't bust it on restart) in **sim** (current-settings) mode. So same-settings re-runs hit; changing any setting (sim) or re-recording the day misses and recomputes.
- **Clearing**: the **Replay Cache** group on the Cache Files page (`/cache-files`) lists every cached result with **Delete All** (clears current + orphaned old-key entries; regenerated on next run). Programmatic: bump `REPLAY_CACHE_VERSION` in [tickReplay.js](src/services/tickReplay.js) on replay/strategy semantic changes, or pass `noCache:true` to `POST /replay/run`. Cancelled runs are never cached.

### REPLAY — fix stale entry LTP on re-subscribed strike

- `_lookupNearest` only forward-filled a strike's **first** subscription. Since a strike is re-subscribed each trade and its option timeline has multi-minute gaps between trades, a later trade's entry inherited the **previous trade's exit price** (e.g. trade 2 entry = trade 1 exit), breaking snapshot↔live-paper determinism. Now forward-fills the nearest after-tick on re-subscription too.

### SWING — opposite-side (flip) cooldown

- **New gate**: after any non-flip exit (Initial/Trail/Breakeven SL, option-stop, PSAR-flip exit, EMA touch-back exit), block entries on the **OPPOSITE side** for `SWING_OPPOSITE_SIDE_COOLDOWN_CANDLES` × `TRADE_RESOLUTION` minutes. Prevents the bot from whipsawing CE→PE→CE in chop within minutes of an exit.
- **Skipped** for legitimate flips and end-of-day: `Opposite signal exit`, `EOD`/`Exit before day close`/`Auto-stop`/`Manual` exits do not trigger the cooldown.
- **Toggle**: `SWING_OPPOSITE_SIDE_COOLDOWN_ENABLED` (default `true`). Candle count: `SWING_OPPOSITE_SIDE_COOLDOWN_CANDLES` (default `3`).
- Applied identically across [swingPaper.js](src/routes/swingPaper.js) (canonical) / [swingLive.js](src/routes/swingLive.js) / [backtestEngine.js](src/services/backtestEngine.js). Settings UI fields added in [settings.js](src/routes/settings.js) (effect: SESSION restart).

### SCALP strategy — redefinition to BB break + PSAR + RSI (V5)

- **New entry logic** in [src/strategies/scalp_bb_cpr.js](src/strategies/scalp_bb_cpr.js) (`getSignal`), applied identically across Paper / Live / Backtest. Entry at candle close, all three true:
  - **CE**: close ≥ **BB upper** · **PSAR below close** · `RSI > SCALP_RSI_CE_THRESHOLD` (default raised 55 → **62**), blocked above `SCALP_RSI_CE_MAX(78)`.
  - **PE**: close ≤ **BB lower** · **PSAR above close** · `RSI < SCALP_RSI_PE_THRESHOLD` (default lowered 45 → **42**), blocked below `SCALP_RSI_PE_MIN(22)`.
- **Indicators kept**: Bollinger Bands `20 / 1`, RSI(14), PSAR `0.02 / 0.2`. PSAR side is now an entry confirmation (was exit-only).
- **Exit simplified** to SAR-based: initial prev-candle SL → **break-even snap** (`SCALP_BREAKEVEN_TRIGGER_R`) → **PSAR trailing** (tighten-only) → **PSAR flip** → bid-ask spread guard → EOD.
- **Resolution**: `SCALP_RESOLUTION` now offers **3 or 5-min** (was 5-only). Aggregation is resolution-agnostic via `getBucketStart`.
- **Removed** (code + Settings UI fields): tiered **% profit-trail** (`SCALP_TRAIL_START/PCT/TIERS/GRACE`), **time-stop** (`SCALP_TIME_STOP_CANDLES/FLAT_PTS`), **pause-override** (`SCALP_PAUSE_OVERRIDE_ENABLED/PTS`), **BB squeeze** (`SCALP_BB_SQUEEZE_FILTER` / `SCALP_BB_MIN_WIDTH_PCT`), **CPR-narrow** (`SCALP_CPR_NARROW_PCT` + `calcCPR`/`isNarrowCPR`), **approach** (`SCALP_REQUIRE_APPROACH`), **body-ratio** (`SCALP_MIN_BODY_RATIO`), **trend filter** (`SCALP_TREND_FILTER` + lookbacks), **activity filter** (`SCALP_ACTIVITY_FILTER` + ratio).
- **Guards kept**: VIX gate (`SCALP_VIX_*`), per-side SL cooldown (`SCALP_SL_PAUSE_CANDLES` / `SCALP_CONSEC_SL_EXTRA_PAUSE` / `SCALP_PER_SIDE_PAUSE`), `SCALP_MAX_DAILY_TRADES` / `SCALP_MAX_DAILY_LOSS`, prev-candle SL caps, trading window, `SCALP_EXPIRY_DAY_ONLY`, optional `SCALP_RSI_TURNING`.
- New authoritative spec: [SCALP.md](SCALP.md) (mirrors [SWING.md](SWING.md)). Files touched: [scalp_bb_cpr.js](src/strategies/scalp_bb_cpr.js), [scalpPaper.js](src/routes/scalpPaper.js), [scalpLive.js](src/routes/scalpLive.js), [scalpBacktest.js](src/routes/scalpBacktest.js), [settings.js](src/routes/settings.js).

### SWING strategy — complete entry/exit redefinition (EMA21 + RSI + SAR)

- **New decision logic** in [src/strategies/strategy1_sar_ema_rsi.js](src/strategies/strategy1_sar_ema_rsi.js) (`getSignal`), applied identically across all 5 SWING modes (Backtest, Paper, Live, Replay, Live Harness) since they all call it. Entry (intra-candle, all 3 true):
  - **CE**: `RSI(14) > RSI_CE_MIN` and `< RSI_CE_MAX` (overbought guard) · price at/above **EMA21 (OHLC4)** (already-above OR crossing up) · SAR below price.
  - **PE**: mirror — `RSI < RSI_PE_MAX` and `> RSI_PE_MIN` (oversold guard) · price at/below EMA21 · SAR above price.
- **Stop / exit** is now a **previous-candle trailing stop**: initial SL = the prior completed candle's low (CE) / high (PE); each candle close tightens SL to that candle's low/high (tighten-only). Exits: prev-candle SL · breakeven (`BREAKEVEN_PTS` → SL to entry) · **option-premium stop** (`OPT_STOP_PCT`, now actually wired into the exit check in Paper + Live, previously log-only) · opposite signal · **exit-before-close** (new `SWING_EOD_EXIT_TIME`, default 15:15) · EOD auto-stop.
- **Same-side SL cooldown** (new `SWING_SL_PAUSE_CANDLES`, default 3): after an SL / option-stop hit on a side, new entries on that side are blocked for N candles (per-side, mirrors SCALP).
- **RSI overbought/oversold guards** (new `RSI_CE_MAX`=80, `RSI_PE_MIN`=20): don't chase exhausted moves.
- **Resolution**: `TRADE_RESOLUTION` now offers **3 / 5 / 15-min** (logic is resolution-agnostic).
- **Removed** from SWING: EMA9 touch, EMA30 trend gate, ADX filter, candle-body filter, SAR-distance gates, Logic-3 SAR-lag overrides, STRONG/MARGINAL strength tiers (entry is always intra-candle now), tiered (T1/T2/T3) trailing, hybrid initial-SL cap, and the 50% candle rule. The corresponding Settings fields were removed; new fields (RSI bands, breakeven, option-stop, cooldown, exit-before-close) added.
- **Guards kept**: VIX gate (`VIX_FILTER_ENABLED` / `VIX_MAX_ENTRY`), `MAX_DAILY_LOSS`, `MAX_DAILY_TRADES`, trading window, `TRADE_EXPIRY_DAY_ONLY`, Swing expiry override/type, `SWING_LIVE_ENABLED` / `SWING_LIVE_DRY_RUN`.
- Files touched: [strategy1_sar_ema_rsi.js](src/strategies/strategy1_sar_ema_rsi.js), [backtestEngine.js](src/services/backtestEngine.js), [swingPaper.js](src/routes/swingPaper.js), [swingLive.js](src/routes/swingLive.js), [settings.js](src/routes/settings.js). Replay + Live Harness inherit via the paper/live engines (no duplicated logic).

### Paper Trade History — unified UI across all 5 strategies + server-side Daily Data Files pagination

- **New shared builder [src/utils/paperHistoryUI.js](src/utils/paperHistoryUI.js)** reproduces the canonical Scalp history page (top-bar actions, summary stat cards, Daily Data Files, Day View, full Analytics + Loss Analysis panels, session cards, trade-detail + JSONL-viewer modals). **ORB and Straddle history pages were rewritten to full parity** — they previously had only session cards + a 4-chart analytics strip and lacked Daily Data Files, Day View, Loss Analysis, the JSONL viewer, and per-date restore. New endpoints added to both: `GET /download/daily-files` (paginated), `GET /download/skips-all`, `GET /view/skips/:date`, `GET /view/trades/:date`, `DELETE /session/:index`, `POST /restore-session/:date`, `GET /reset`.
- **Daily Data Files table now paginates server-side** on all 5 strategies (Scalp/Swing/PA/ORB/Straddle). The `/download/daily-files` endpoint accepts `?page=&pageSize=` and returns `{ rows, total, page, pageSize, totalPages }` (shared `dailyFilesPaginate()` helper); `pageSize=0` returns all rows (used by "Copy All Data"). Replaces the previous client-side `enhanceTable` pagination that loaded every date row up-front.
- **UI_THEME light toggle now honored on every history page.** Scalp/PA never set `data-theme` (always dark); the shared builder now emits `themeInitScript()` + `historyLightCSS()` (Scalp/PA inject them too), so all five follow the Settings theme toggle identically.
- **All 5 history pages now route through the shared builder** (`renderHistoryPage()`) — Scalp, Swing, PA, ORB, and Straddle. ~4,300 lines of duplicated inline page HTML/JS deleted across the five routes; the page UI is now a single source of truth.
- **Generic filter + extra-analytics hooks** added so PA keeps its pattern-attribution features on the shared page: `cfg.filter` ({ field, label }) renders a top-bar dropdown that narrows session cards, summary stat cards, Day View, and Analytics by any per-trade field (PA uses `patternGroup`, derived from `entryReason`); `cfg.extraAnalyticsHTML`/`extraAnalyticsJS` inject PA's full-data "Pattern Breakdown" table (click a row to filter). Day View / Analytics read a shared `ACTIVE_TRADES` set so the filter flows through everywhere. `?filter=`/`?pattern=` URL param preselects a group.

### Live trading — per-strategy DRY-RUN override (staged real-money rollout)

- **`{STRATEGY}_LIVE_DRY_RUN` per-strategy overrides** added so live strategies can be graduated to real money independently. Previously `LIVE_HARNESS_DRY_RUN` was a single global switch — flipping it OFF made *every* enabled live strategy place real orders at once, so you couldn't run e.g. Swing on real money while keeping ORB simulated.
- New shared gate [src/utils/liveDryRun.js](src/utils/liveDryRun.js): a strategy is dry-run if the **global** `LIVE_HARNESS_DRY_RUN` is on (forces all), **or** its own `SWING_LIVE_DRY_RUN` / `ORB_LIVE_DRY_RUN` / `PA_LIVE_DRY_RUN` / `STRADDLE_LIVE_DRY_RUN` / `SCALP_LIVE_DRY_RUN` is on. Overrides can only **add** safety, never remove it. All default `false`, so behaviour is unchanged until explicitly set.
- Wired into [swingLive.js](src/routes/swingLive.js), [orbLive.js](src/routes/orbLive.js), [straddleLive.js](src/routes/straddleLive.js), [paLiveHarness.js](src/routes/paLiveHarness.js), [scalpLive.js](src/routes/scalpLive.js); all five toggles exposed in the [Settings UI](src/routes/settings.js). Example: `LIVE_HARNESS_DRY_RUN=false` + `ORB_LIVE_DRY_RUN=true` → Swing places real orders while ORB stays logged-only.
- **Scalp Live previously had NO dry-run guard at all** (it placed Fyers orders directly regardless of any flag). It now honours the same gate — and since Scalp Live has no separate master-enable toggle, `SCALP_LIVE_DRY_RUN` (plus the global flag) is its primary safety switch. With the global flag at its default (on), Scalp Live is now simulated by default instead of placing real orders.

### Trade logging — uniform entry-context + MFE/MAE + exit VIX across all 5 strategies

- **Every strategy's trade record now captures the signal diagnostics it already computes at entry** but previously discarded ([src/routes/](src/routes/) paper + live for PA, ORB, Straddle, Swing; Scalp already had entry context). PA logs `rsiAtEntry`/`adxAtEntry`/`adxRising`/`isTrending`/`patternAtEntry`/`srLevelAtEntry`; ORB logs `vwapAligned`/`volPass`/`wickPass`; Swing logs `ema9AtEntry`/`ema9Slope`/`sarAtEntry`/`sarTrend`/`adxAtEntry`/`adxTrending`; Straddle already logged `trigger`/`bbWidth`/`bbWidthAvg`.
- **MFE/MAE excursion tracked per-tick on all 5** (max-favorable + max-adverse in spot pts and ₹; Straddle uses combined-premium swing + `maxSpotMovePts` since it's delta-neutral). Scalp gained MAE alongside its existing MFE.
- **`secsToMFE` / `secsToMAE`** — seconds from entry to the favorable peak / adverse trough, so "peaked early then bled out" is distinguishable from "slow grind" (the key signal for trail-start / grace tuning). Measured in each strategy's own tick clock (`simNow()` for the replayed paper engines, `Date.now()` for live / ORB / Straddle) so a replayed session reproduces identical values — preserves the "replay snap 1 == live recording" invariant.
- **`vixAtExit`** added to every trade record (read from the existing VIX cache — no new network poll), pairing with the existing `vixAtEntry`.
- **Pure additive logging** — no entry, exit, SL, trail, or fill logic changed on any strategy or mode; paper logic untouched. Within the active paper-trade data-collection window. Lets post-window analysis correlate how each engine reacted to the market conditions present at entry/exit without reconstructing them from raw ticks.

### Dashboard — fix P&L chart fill colour above zero

- **The cumulative/module chart fill now splits at the zero line.** Previously the area fill was a single colour keyed off the net total, so a net-negative chart painted the whole area red even where the line ran green above ₹0. The fill ([src/app.js](src/app.js)) is now a vertical gradient — green above the zero baseline, red below — matching the per-segment line colour.

### Dashboard — one global Paper/Live toggle for all charts

- **Replaced the six per-card Paper/Live toggles with a single top-bar toggle.** Each strategy chart (Swing/Scalp/PA/ORB/Straddle) and the Cumulative P&L card carried its own Paper/Live switch; they're removed in favour of one square PAPER/LIVE toggle in the dashboard top-bar ([src/app.js](src/app.js)), defaulting to PAPER. Flipping it re-renders every module chart and the cumulative chart from the chosen source at once. Dead per-card toggle markup, click handlers, and CSS removed.
- **Top bar kept to a single line.** The title, toggle, and action buttons/pills no longer wrap to a second row — the bar stays one line and scrolls horizontally if it ever overflows.
- **The "Start All" quick-action now follows the same toggle.** The separate "▶ All Paper" / "▶ All Live" buttons collapse into one "▶ Start All (Paper/Live)" button that starts whichever mode the toggle selects (PAPER → all paper modes, LIVE → all live modes, with the existing live confirm prompt). The Paper↔Live mutual-lock poller is preserved — it now drives the single button (shows "● PAPER/LIVE ACTIVE" or "🔒 …locked" against the selected mode).

### Paper capital — broker investment pools replace per-strategy capital

- **Five per-strategy paper-capital settings collapsed into two broker-level pools.** `SWING_PAPER_CAPITAL`, `SCALP_PAPER_CAPITAL`, `PA_PAPER_CAPITAL`, `ORB_PAPER_CAPITAL`, and `STRADDLE_PAPER_CAPITAL` are removed from Settings and replaced by `ZERODHA_INV_AMOUNT` (Swing) and `FYERS_INV_AMOUNT` (Scalp + PA + ORB + Straddle), matching how each strategy is brokered ([src/routes/settings.js](src/routes/settings.js)). Each strategy now reads its broker pool as its starting capital; running capital is still `pool + all-time P&L`, so existing on-disk `totalPnl` is preserved (defaults unchanged at ₹100000).
- **Dashboard shows each broker pool's remaining balance.** The main dashboard's broker-connection rows ([src/app.js](src/app.js)) now display each pool inline — remaining = pool + summed all-time paper P&L of that broker's enabled strategies (Fyers row sums Scalp/PA/ORB/Straddle, Zerodha row = Swing), read server-side from the `*_paper_trades.json` totals. The rows were also tightened to make room. The Real-Time Monitor ([src/routes/realtime.js](src/routes/realtime.js)) carries the same pools as a wallet strip above the strategy cards (computed client-side from the `totalPnl`/`capital` each `/status/data` already returns). Pools only appear when at least one strategy on that broker is enabled.
- Settings/display plumbing only — no paper decision/fill/exit logic or strategy params changed; capital is display-only (kill-switches read session P&L). The `*_LIVE_CAPITAL` fallbacks in [src/routes/orbLive.js](src/routes/orbLive.js) / [src/routes/straddleLive.js](src/routes/straddleLive.js) now fall back to `FYERS_INV_AMOUNT` instead of the removed paper keys.

### Replay — Cancel button for a running replay

- **A running replay can now be cancelled mid-session.** While a date-range batch (or single session) replays, a red **✕ Cancel** button appears next to the run button (in [src/routes/replay.js](src/routes/replay.js)). Clicking it POSTs `/replay/cancel`, which sets a flag the spot-tick streaming loop in [src/services/tickReplay.js](src/services/tickReplay.js) checks each tick — the loop stops early, runs `/stop` to square off cleanly, and returns `cancelled: true` so the replay-in-progress flag clears with no stuck state. The batch then halts before the next session and reports "🛑 Cancelled".
- Diagnostic/UI plumbing only — no paper decision/fill/exit logic, strategy params, or env changed (the cancel path reuses paper's own `/stop` squaring-off).

### Replay — fix absurd PnL when a trade enters before its first option tick

- **Replay no longer poisons entry LTP with the spot price.** When a strategy entered slightly before the recorded option timeline's first tick (e.g. swing entering at 09:36:16 while `NIFTY…23700CE`'s first recorded tick is 09:36:26), `_lookupNearest` in [src/services/tickReplay.js](src/services/tickReplay.js) returned `no_data`, so paper's 10s spot-proxy fallback set `optionEntryLtp` to the spot price (~100× the premium). Mixing that with a real exit premium produced six-figure-negative PnL (e.g. −₹1,529,787 on one trade), which then tripped `MAX_DAILY_LOSS` and suppressed every later entry (1 replayed trade vs 5 live).
- **Fix:** when `replayNow` precedes a freshly-subscribed symbol's first recorded tick, `_lookupNearest` now forward-fills that first tick — mirroring live, where the first option websocket tick after subscription fills `optionEntryLtp`. Entry LTP now matches the live recording's first-tick premium; mid-trade and exit lookups are unchanged (they always have a prior tick).
- Replay/diagnostic correctness only — no paper decision/fill/exit logic, strategy params, or env changed.

### Replay — fix "Baseline FAILED — No canonical paper-trade record found"

- **The baseline (live recording) now matches across all modes.** `_lookupCanonicalSession` in [src/services/tickReplay.js](src/services/tickReplay.js) compared `Date.parse(session.date)` against the intraday session-start timestamp within a **60-second** window. The catch: `session.date` is written two different ways — swing stores a date-only string (`"2026-05-21"`, parses to midnight UTC → hours off the window → never matched), while pa/scalp/orb/straddle store a full ISO timestamp (`state.sessionStart`, which *was* within the window). So swing never matched and the others did. The matcher now normalises **either** form to a UTC calendar day and matches on that, with a tiebreak on the closest start instant when a day has multiple sessions — so all five modes match.
- **Baseline PnL is no longer ₹0 on a match.** It read `session.pnl`, but sessions store the field as `sessionPnl` (legacy `pnl` kept as fallback) — so even a matched session showed ₹0. Now reads `sessionPnl` first.
- Read-only matcher fix — touches no paper/strategy/env logic and never writes the canonical file.

### Replay — diagnostic now shows the baseline (live) trades for a per-trade diff

- **The diagnostic's "Baseline trades (full JSON)" was always `[]`.** `_lookupCanonicalSession` returned only the matched session's summary (pnl, count), so there was nothing to compare YourCfg's per-trade output against. It now also returns the matched live trades, normalised to the same compact shape the replay run emits (`side/strike/expiry/entry/exit/eSpot/eOpt/eSl/xSpot/xOpt/pnl/reason/symbol`, chronological) — wired into the baseline object in [src/routes/replay.js](src/routes/replay.js). The diagnostic now prints baseline trade N alongside YourCfg trade N so a divergence (extra entry, shifted exit, different fill) is visible at a glance.
- Additive diagnostic only — read-only, no canonical-file writes, no paper/strategy/env logic changed.

### Mobile responsive — full app usable on a phone (iPhone 15)

- **Every screen now reflows for narrow viewports.** The shared mobile layer in [src/utils/sharedNav.js](src/utils/sharedNav.js) (`sidebarCSS()` `@media(max-width:768px)`) — inherited by all 33 shell pages — was expanded to: collapse multi-column grids to a single column (named grids `.stat-grid-2/.ana-row/.stats/.roll-grid/.pos-grid/.metric-grid/.compare-grid/.baseline-grid/.actions/.pattern-grid` plus any inline `grid-template-columns`), make stray `<table>`s scroll horizontally instead of overflowing, wrap the top bar / run bar / capital strip, and cap inputs, `<pre>`, and media at the screen width. The sidebar already collapsed behind a hamburger; that is unchanged.
- **Added the `viewport` meta tag** to the four pages that lacked it (`orbBacktest`, `straddleBacktest`, `replay`, `paLiveHarness`) so iOS Safari renders at device width instead of a zoomed-out desktop layout.
- **Standalone result page** ([src/routes/result.js](src/routes/result.js), no shared shell) got its own `@media(max-width:768px)` block — tighter padding, wrapping nav, and horizontally scrollable trade tables.
- Presentation only — no strategy, paper/live decision, env, or route changes.

### Trade Logs — one-click Restore for settings changes

- **Every row in the Checkpoints & Settings Changes tab now has a `↩ Restore` button** ([src/routes/tradeLogs.js](src/routes/tradeLogs.js)) that reverts that key to its prior (`From`) value with a single confirm. If the change was an "add", restoring deletes the key again. After restore, keys that are cached at startup trigger a one-click "Restart now" prompt (polls `/settings/data` and reloads when the server returns).
- **"Restore all keys with the same note" checkbox** appears in the confirm dialog *only* when the audit entry carries a note. When checked, every key ever changed under that exact note is reverted to its **earliest** `From` (the value before that note's first change) — so a whole noted checkpoint can be rolled back at once.
- New route `POST /settings/audit-restore` ([src/routes/settings.js](src/routes/settings.js)), API_SECRET-protected. It reuses the same apply path as `/settings/save` (extracted into a shared `persistChanges()` helper), so a restore writes an identical settings-audit entry + per-mode daily snapshot and is itself reversible. Restore audit entries are tagged `↩ restore …` notes.

### Backup & Restore — daily downloadable data snapshots

- **New self-contained daily backup so an EC2 loss never loses data.** [src/utils/backupManager.js](src/utils/backupManager.js) cuts a `.tar.gz` of `~/trading-data` **and** the recorded `data/ticks` feed into `~/trading-data/_backups/backup-YYYY-MM-DD.tar.gz`, **excluding** disposable items (`backtest_cache/`, `candle_cache/`, the daily-regenerated `.fyers_token`/`.zerodha_token`, and the `_backups/` store itself). Each archive is a full snapshot — one download fully restores. Written to `.tmp` then renamed so a download never reads a half-written file.
- **Download it from Settings → Backup & Restore.** A new card lists every on-server snapshot (date, size, downloaded ✓/⏳), with **Download latest**, **Snapshot now**, and copy-paste restore instructions. New routes ([src/routes/backup.js](src/routes/backup.js)): `GET /backup/status`, `GET /backup/data`, `GET /backup/download?date=…` (marks downloaded), `POST /backup/create`.
- **Nag banner until the day's copy is downloaded.** [src/utils/sharedNav.js](src/utils/sharedNav.js) shows a fixed top banner on every page — "📦 Data backup for &lt;date&gt; is ready — ⬇ Download now" — that polls `/backup/status` and stays until the day's snapshot has actually been downloaded (mirrors the existing broker-socket banner pattern).
- **Only the latest snapshot is kept** — generating a new one (boot, "Snapshot now", or the daily run) deletes all earlier dated snapshots. `BACKUP_RETAIN_DAYS` now governs only the hidden pre-restore safety snapshots.
- **Scheduler** mirrors `consolidatedEodReporter` (setTimeout → reschedule): cuts a snapshot daily at `BACKUP_HOUR_IST` (default 16:00 IST, after close), creates one on boot if today's is missing. New env: `BACKUP_ENABLED` (default true), `BACKUP_HOUR_IST`, `BACKUP_RETAIN_DAYS`, `BACKUP_TG_ENABLED` (Telegram heartbeat, default off) — all exposed in Settings under "COMMON — Backup & Restore".
- Additive observer only — reads data files and shells out to `tar`; no strategy decision/fill/exit logic touched.

### Backup & Restore — restore from the UI (no SSH)

- **Restore a backup straight from the 📦 BACKUP modal.** New "⟲ Restore from a backup file" control uploads a `backup-*.tar.gz` and restores it server-side over `~/trading-data` + `data/ticks` — no SSH needed. Route: `POST /backup/restore` ([src/routes/backup.js](src/routes/backup.js)) streams the raw body to a temp file, then [backupManager.restoreFromFile](src/utils/backupManager.js) handles it.
- **Safety rails on a destructive op:** (1) refused while any paper/live session is active (`sharedSocketState.isAnyActive()`); (2) a **pre-restore snapshot** of current data is cut first (`backup-prerestore-*.tar.gz`, pruned by mtime, hidden from the dated list) so a bad restore is reversible; (3) archive entries are validated against path-traversal (no absolute paths, no `..`, must live under `trading-data/` or `data/ticks/`) and link entries are refused; (4) extraction is **selective** — only the two known dirs are unpacked, so foreign members are never written. UI requires a double-confirm and offers a restart afterwards.

### Replay — candlestick chart + clean trade table + collapsible sessions

- **Replay result now draws the same candlestick chart the paper screen does.** Both the single-session per-row result and the date-range comparison ([src/routes/replay.js](src/routes/replay.js)) render a Lightweight-Charts price chart with entry/exit markers and the per-mode overlays (BB bands, SAR, EMA9, ORH/ORL lines). In the date-range view each session gets its own chart + trade table; a single-session range expands and draws immediately, multi-session ranges draw each chart lazily on first expand. The replay engine ([src/services/tickReplay.js](src/services/tickReplay.js)) harvests the route's in-memory `/status/chart-data` after `/stop` and returns it as `chartData` — the replay's own bars, no disk/broker re-fetch.
- **Entry/exit reasons shown in a clean table.** Replay trades render in a proper table (side, entry/exit time, prices, P&L, entry reason, exit reason) instead of a raw-JSON dump. The raw JSON stays available in a collapsed `<details>` for debugging.
- **Recorded sessions card is collapsible, collapsed by default.** Click the "Recorded sessions" header to expand/collapse the filters + table + pager.
- **0-result replay no longer counted as an improvement.** When a replay produces ₹0 (0 trades / no setup / data hole), the comparison previously credited it as beating a live loss (e.g. live −₹732 → delta +₹732, "improved"). A 0 replay is no result, not a deliberate win — the per-session and aggregate delta now treat it as a neutral 0. Applied to both single-session and date-range views.
- **Force-clear now actually unsticks a dead replay.** `forceClearSharedState()` ([src/services/tickReplay.js](src/services/tickReplay.js)) previously cleared only the strategy mutexes, never `_replayInProgress` — so a run killed mid-flight (e.g. by a deploy/PM2 reload before its `finally{}` reset the flag) left "Another replay is already running in this process" stuck forever with no actual run, and the Force-clear button couldn't fix it. It now resets `_replayInProgress` too. The preflight banner also stopped hiding the button behind the dead-end "wait for it to finish, or open the tab that started it" text for that message — it always offers a Force-clear button now, with wording matched to the cause.
- Additive UI + best-effort chart harvest only — no strategy decision/fill/exit logic touched.

### Swing Live — DRY-RUN harness gate

- **Swing Live now honours `LIVE_HARNESS_DRY_RUN`.** Previously Swing Live ([src/routes/swingLive.js](src/routes/swingLive.js)) called Zerodha directly the moment `SWING_LIVE_ENABLED=true` — it had no dry-run safety net, unlike the Fyers strategies (PA/ORB/Straddle). All four real-order paths — market entry/exit (`placeMarketOrder`), hard SL-M placement (`placeHardSL`), trail modify (`updateHardSL`), and SL cancel (`cancelHardSL`) — are now gated: when `LIVE_HARNESS_DRY_RUN=true` (default) each logs the broker call it *would* make and returns a simulated success against a `DRYRUN-*` virtual order ID, placing no real order. The engine's position / hard-SL / trail / P&L bookkeeping runs end-to-end against virtual fills so decisions can be validated before flipping to real money. Fill-verification polling (`verifyOrderFill`) is skipped in dry-run (no real order to poll).
- **Visibility:** the `/swing-live/status` page shows a server-rendered DRY-RUN (amber) / LIVE (red) banner under the broker badges, the start-up log prints the active order mode, and `/swing-live/status/data` exposes a `dryRun` flag. No new env key or Settings toggle — reuses the existing `LIVE_HARNESS_DRY_RUN` switch already in Settings.
- Additive gating + logging only — no strategy decision/fill/exit logic touched; Swing Paper untouched.

### Telegram — ORB + Straddle alert toggles + consolidated report coverage

- **Per-strategy toggles for ORB and Straddle.** `modeGroup()` in [src/utils/notify.js](src/utils/notify.js) previously had no ORB/Straddle branch, so their `ORB-*` / `STRADDLE-*` mode strings fell through to the `SWING` default — meaning ORB/Straddle entry/exit/started/day-report alerts were silently controlled by the `TG_SWING_*` toggles and couldn't be muted independently. Added `ORB` and `STRADDLE` groups (prefix-matched so the live `(DRY-RUN)` suffix still resolves) plus matching `modeLabel()` cases for clean message headers. New Settings toggles: `TG_{ORB,STRADDLE}_{STARTED,ENTRY,EXIT,DAYREPORT}` (all default `true`, preserving prior always-on behaviour). No `_SIGNALS` toggle — neither strategy emits candle-close signal alerts.
- **Consolidated EOD report now includes ORB + Straddle.** [src/utils/consolidatedEodReporter.js](src/utils/consolidatedEodReporter.js) read only the 6 swing/scalp/PA files; added `orb_{paper,live}_trades.json` and `straddle_{paper,live}_trades.json` (10 sources total) and the two new `byMode` buckets. `notifyConsolidatedDayReport()` now renders all five strategy rows (column padding widened for `STRADDLE`).
- **Reports follow the strategy master toggles.** Every alert (`notifyStarted/Entry/Exit/Signal/DayReport`) and the consolidated report are now gated by `{GROUP}_MODE_ENABLED` via a new `isModeEnabled()` helper — a strategy disabled in Settings sends no alerts and is omitted from the consolidated report, regardless of its `TG_*` toggles.
- **Straddle counts now collapse legs to pairs.** Straddle persists one record per leg (CE/PE) sharing a `pairId` + combined `pairPnl`; the day report and consolidated report were counting each leg, so a winning pair showed as 1 win + 1 loss and the trade count was doubled. New `straddlePairStats()` helper (used by both reports) groups by `pairId` and tallies wins/losses on `pairPnl`, mirroring the Straddle history page. Net P&L was already correct (it came from `sessionPnl` / summed `pairPnl`); only counts and win-rate were affected.
- Additive notification wiring only — no strategy decision/fill/exit logic touched.

### Docs — Sync README.md + CLAUDE.md with current app

- **README.md** now reflects the five-strategy reality (Swing / Scalp / PA / **ORB** / **Straddle**). Updated the architecture diagram, the modes table, the strategies section (new ORB and Straddle write-ups, PA breakeven trigger), the env-var tables (added every `ORB_*` / `STRADDLE_*` key with current defaults; corrected stale defaults for `MAX_DAILY_TRADES`, `SCALP_MAX_SL_PTS`, `SCALP_TRAIL_START`, `SCALP_TRAIL_TIERS`, `SCALP_MAX_DAILY_LOSS`, `PA_TRAIL_START`, `PA_TRAIL_TIERS`, `PA_CANDLE_TRAIL_BARS`, `PA_RSI_CAPS_ENABLED`), the routes section (ORB / Straddle / Replay / All-Backtest / paLiveHarness / paPatternBacktest), the persistence layout (per-day `ticks/`, `_replay_trades/`, `_replay_trades_sim/`; gap noted that `.active_orb_position.json` / `.active_straddle_position.json` don't exist yet), the menu-visibility / security tables, and the project structure tree.
- **CLAUDE.md** routes paragraph now lists the unified pages (Real-Time, Replay, All-Backtest, consolidation, tradeLogs) and adds a 4th step to the "wiring a new strategy" checklist — register with the shared monitors gated by `{STRATEGY}_MODE_ENABLED`. Persistent-data section now includes `ticks/` + `_replay_trades/` and calls out the ORB/Straddle position-persist gap. Added "Live order placement is double-gated" and "Tick recorder is the source of truth for Replay" guidance to the working-in-repo section.
- Pure docs sync — no code paths touched.

### Settings — Drop orphan PA_ADX_DIRECTIONAL row

- Removed the `PA_ADX_DIRECTIONAL` toggle from the PA section of the Settings UI ([src/routes/settings.js](src/routes/settings.js)). The row was advertising a directional ADX gate (require `+DI > -DI` for CE / `-DI > +DI` for PE) that the engine never actually enforced — no reader exists in [src/strategies/price_action.js](src/strategies/price_action.js). Removing the UI to stop misleading the operator; the gate itself can be added after the paper-trade data-collection window closes (~2026-06-02) without re-introducing UI drift.

### Replay — Date-range loop fix + pump speedup

- **Bug:** picking a multi-day range on the Replay page only ran the first session and never rendered a result. `renderRangeResult()` in [src/routes/replay.js](src/routes/replay.js) declared a local `const modeTag` that shadowed the outer `modeTag()` helper and called itself in its own initializer — a TDZ ReferenceError thrown on the first per-row "live partial render" tore down the orchestration loop before session 2 began. Renamed the local to `headerTagClass` so the outer helper resolves cleanly at line 1289.
- **Perf:** `harness.setWallClock()` in [src/services/tickReplay.js](src/services/tickReplay.js) is called once per pumped tick (~55k+ times per session) to keep `Date.now()` inside strategies pinned to the recorded timestamp. It used to reassign `Date.now`'s slot on every call, forcing V8 to deopt the global. Now installs a stable closure function once and only mutates the closure variable on the hot path. Measurable speedup on the date-range view; pure plumbing change — replay results are bit-identical.

### Real-Time Monitor — ORB + Straddle cards

- The Real-Time Monitor ([src/routes/realtime.js](src/routes/realtime.js)) now renders cards and rollup rows for **every strategy enabled in Settings** (SWING, SCALP, PA, ORB, STRADDLE), not just the original three. Each card is gated by `{STRATEGY}_MODE_ENABLED` and disappears when the toggle is off.
- Field-shape differences are normalised client-side: ORB's `livePnl` / `tradesTaken` / `slSpot` / `currentOptLtp` / `log[]` and Straddle's CE+PE legs (`pos.ce` / `pos.pe`, `netDebit`, `combined`) now render correctly. Straddle gets a tailored position card showing both legs, net debit, target/stop net, and combined LTP.
- Card grid switched to `auto-fit, minmax(280px, 1fr)` so 4–5 strategies wrap responsively instead of overflowing the 3-column layout. ORB uses emerald, Straddle uses pink accent colours.
- Strategies without per-date JSONL endpoints (ORB, Straddle) show a disabled "— No Day Log —" placeholder instead of a "Copy Day Log" button that would 404.

---

## v4.5.0 — 5-Min Swing Default, Scalp Pause Override, PA Reversal Fixes, Trade Logs Manager (2026-05-14)

### Swing — Default Resolution Changed to 5-Min

- **`TRADE_RESOLUTION` default changed from `15` → `5`** ([src/routes/swingPaper.js](src/routes/swingPaper.js), [src/routes/swingLive.js](src/routes/swingLive.js), [src/strategies/strategy1_sar_ema_rsi.js](src/strategies/strategy1_sar_ema_rsi.js)).
- 15-min wasn't taking entries during the paper-trade data-collection window. The strategy itself is unchanged — all `TRADE_RES === 5` vs `>= 15` runtime branches are preserved, so flipping `TRADE_RESOLUTION=15` in `.env` (or via Settings UI) restores the prior behavior with no code change.
- Strategy header / description string updated to reflect the new default.

### Swing — `SWING_STRONG_ONLY` Toggle

- **`SWING_STRONG_ONLY`** (default `false`) — when on, blocks **MARGINAL** signals on the **candle-close** entry path (intra-candle path was already STRONG-only, so this closes the asymmetry).
- Blocked entries are recorded to `skipLogger` with `gate: "strong_only"` for audit.
- Wired into both Swing Paper and Swing Live; surfaced in Settings UI.

### Scalp — Pause Override on Retest-and-Resume

- **`SCALP_PAUSE_OVERRIDE_ENABLED`** (default `false`) + **`SCALP_PAUSE_OVERRIDE_PTS`** (default `10`) ([src/routes/scalpPaper.js](src/routes/scalpPaper.js), [src/routes/scalpLive.js](src/routes/scalpLive.js)).
- After a per-side SL hit, scalp normally cools down on that side for N candles. This blocked re-entry on the common pattern where price retests through the entry (hitting SL), then resumes in the original direction — the bot sat idle while the actual move played out.
- New gate: when a candle closes ≥ `SCALP_PAUSE_OVERRIDE_PTS` past the failed-entry spot in the original direction, the per-side pause is released early and the consecutive-SL counter for that side is reset. Genuine fails still cool down normally; only confirmed resumption clears the pause.
- New state field `_lastSLSpotBySide: { CE, PE }` records the spot at which each side last failed.

### Scalp — Trail / Breakeven Fixes

- **Trail uses PnL floor** instead of spot-delta model ([src/routes/scalpPaper.js](src/routes/scalpPaper.js), [src/routes/scalpLive.js](src/routes/scalpLive.js)) — fixes mismatches between the trail % the user configured and the rupee floor actually enforced.
- **Breakeven snap fires per-tick, not per-bar** — moves the breakeven jump out of the once-per-candle path so it can fire intra-bar once profit clears the threshold. Matches the rest of the tick-driven exit stack.

### Scalp — Per-Trade Context Logging (additive only)

- Each scalp trade record now captures BB / RSI / trend context at entry and **MFE** (max-favorable excursion in points) over the life of the trade ([feat(scalp): log BB/RSI/trend context + MFE per trade](src/routes/scalpPaper.js)).
- Pure logging — no entry, exit, SL, or trail logic changed. Feeds the active paper-trade data-collection schema.

### Scalp — `SCALP_CPR_NARROW_PCT` Now Editable in Settings

- `SCALP_CPR_NARROW_PCT` (CPR-narrow filter threshold) was code-only; now exposed as a Settings UI knob.

### Price Action — Reversal Pattern Fixes (additive)

- **BOS / Inside-Bar exempt from the ADX directional gate** ([src/strategies/price_action.js](src/strategies/price_action.js)) — these are explicit breakout patterns; gating them by ADX direction was suppressing the very signals they're meant to catch. Restart-survival also added so the BOS/IB pending state isn't lost across a process restart.
- **Reversal patterns** (Engulfing, Pin Bar, Double Top/Bottom): RSI logic was inverted (CE was requiring RSI > 45 / PE requiring RSI < 55 — wrong sign for reversal entries) and the swing-detection lookback was tightened. Reversal patterns are also now exempt from the ADX directional gate (an ADX-confirmed downtrend is exactly when a bullish reversal at support is most actionable).
- **Reverted** the `feat(pa): tighten loss/win asymmetry + add weekly trade report` change after backtest regression — current PA exit stack (candle trail + tiered profit-lock + PSAR + time-stop) remains the canonical configuration.

### Trade Logs Page — Renamed + Cumulative Skip Logs + Drop CSV/PDF

- **JSONL viewer renamed to "Trade Logs"** across the UI and routes ([feat(history): rename JSONL→tradeLogs, add cumulative skipLogs, drop CSV/PDF](src/routes/)).
- **Cumulative skip logs** now shown alongside per-day trade logs in a dedicated tab — easier to audit *why* the bot didn't take entries over a multi-day window.
- **CSV / PDF export removed** — JSONL is the canonical source of truth; the secondary formats were drifting from JSONL on edge cases. Downloads now land consistently as `.jsonl` (with a parallel `.txt` option for raw paste).
- **Per-mode "Download All" + "Delete All"** buttons — bulk-export or wipe an entire mode's logs in one click. Light-theme overrides included.
- **Toast notifications** on the Trade Logs page were silent (`showToast was undefined`) — now wired correctly.

### Settings — Checkpoint Notes + Skip-Log Tab + Snapshot in Daily JSONL

- **Checkpoint note prompt on Settings save** — every save can now be tagged with a one-line note ("rolled back PA RSI inversion", "tightened scalp body ratio to 0.5", etc.), creating an audit trail of *why* a config changed.
- **Daily trade JSONL is now seeded with the current settings snapshot at session start** and re-appends on every Settings save during the session — so the JSONL log carries the exact config that produced each day's trades. No more "what was `SCALP_TRAIL_GRACE_SECS` set to on May 8?" guesswork.
- **Skip-log tab** added to the Trade Logs / Settings flow alongside trade entries.

### Sidebar — Per-Menu and Per-Submenu Visibility Toggles

- **Per-menu visibility toggles** ([feat(ui): per-menu visibility toggles in Settings](src/utils/sharedNav.js)) — hide entire mode sections (Swing / Scalp / PA) from the sidebar without disabling the underlying engine.
- **Per-submenu visibility toggles** — finer-grained: hide individual links (e.g., hide "Backtest" but keep "Paper" and "Live") within a still-visible mode section.
- Driven by env vars + Settings UI; persists across restart. Lets you declutter the sidebar to match the workflow you actually use.

### Auth — Mobile-Friendly Login + Token Display + Pre-Start Verification

- **Mobile-friendly login flow** ([feat(auth): mobile-friendly login flow + pre-start token verification](src/routes/auth.js)) — the OAuth round-trip was previously redirecting back to a desktop-only landing page. Now responsive end-to-end.
- **Pre-start token verification** — before booting trading engines, a quick token-validity check runs; if Fyers/Zerodha auth is stale, the user is bounced to re-login *before* a position can open with a dead token.
- **Access token displayed with Copy button** after manual login — useful for cross-checking tokens against the broker's own session manager.
- **Fyers socket auth failure (code -15)** now bails out + sends a Telegram alert instead of silently retrying ([fix(socket): bail + alert on Fyers auth failure (code -15)](src/utils/socketManager.js)).

### Expiry / 0DTE Handling

- **Swing blocks `/start` when the configured expiry == today** ([feat(swing): block start when configured expiry == today (0DTE warning)](src/routes/swingPaper.js)) — refuses to trade 0DTE for the swing strategy (gamma risk on intraday holding through expiry).
- **Per-mode option expiry override** ([feat(swing): per-mode option expiry override (avoid 0DTE on Tuesdays)](src/config/instrument.js)) — each mode (Swing/Scalp/PA) can now set its own expiry override independent of the global setting. Useful when scalp is fine on Tue weekly expiry but swing should roll to next Tue.
- **Dashboard handles 0DTE warning in Start-All flows** — All-Paper / All-Live now catches the 0DTE refusal per mode and surfaces it in the start-all error modal instead of silently skipping.
- **Red banner on dashboard** when a manual expiry-override session has ended (i.e., the override date is in the past) so a stale override doesn't quietly block trading.
- **Expiry calendar fix** — calendar was showing Mon dates instead of Tue (UTC shift bug); now correctly shows Tue weekly NIFTY expiries.
- **Settings expiry modal** no longer throws on a missing `year-title` element.

### Real-Time Monitor — Per-Card Action Buttons + Mini Activity Log

- **Per-card "Open Status" + "Copy Day Log" buttons** ([feat(realtime): per-card Open Status + Copy Day Log buttons](src/routes/realtime.js)) — each strategy card on `/realtime` now has direct jump-to-status and one-click day-log copy.
- **Copy Day Log copies raw entry + skip JSONL**, not the human-readable summary — useful for paste-into-LLM analysis.
- **Compact 5-line activity-log preview inside each SWING / SCALP / PA card** ([feat(realtime): show recent activity log per strategy card](src/routes/realtime.js)) — at-a-glance confirmation the engines are alive when flat. Uses the existing `logs` / `logTotal` fields each `/status/data` endpoint already returns; no backend changes.
- **Layout fix** — `<a>` and `<button>` heights/centering aligned in the action row.

### Settings — Swing Section Labels Renamed (15-min → 5-min)

- User-visible section headers, Telegram alert descriptions, and the section-summary modal title now read **5-min** instead of 15-min, matching the new `TRADE_RESOLUTION` default ([feat(ui): rename Swing strategy labels 15-min → 5-min](src/routes/settings.js)). `SECTION_TO_MASTER` visibility map updated in lockstep (keyed by the exact title string, so any drift would silently break the per-section visibility toggle).

### Charts — Zoom Preserved, Pre-Market Junk Dropped, Strategy Overlays

- **Zoom preserved across refresh** on paper-trade charts ([fix(paper-charts): preserve zoom, drop pre-market junk, add strategy overlays](src/routes/)).
- **Pre-market junk dropped** — sub-09:15 ticks no longer pollute the candle chart x-axis.
- **Strategy overlays** added consistently across paper charts (matches what live charts already had).

### Activity Log — Copy Button

- **"Copy Log" button** ([feat(ui): add Copy Log button to activity log](src/routes/)) on the activity-log header of paLive, paPaper, swingLive, swingPaper. `navigator.clipboard` with textarea fallback. Mirrors the existing `copyTradeLog` pattern.

### Settings — Eye-Icon Modal Consolidation

- **Two eye-icon modals consolidated into a top-bar button** — was creating UI noise at the section level; now a single top-bar action covers both.

### Performance — gzip Compression

- **`compression` middleware applied to all responses** ([perf: gzip-compress all responses](src/app.js)) — `/settings` page dropped from **329 KB → 61 KB** (≈80% reduction). Same wins across all HTML routes.

### Misc

- `/data` directory added to `.gitignore`.

---

## v4.4.1 — Unified Real-Time Monitor (2026-05-02)

### Real-Time Monitor — One Screen, PAPER/LIVE Toggle

- **New route `/realtime`** ([src/routes/realtime.js](src/routes/realtime.js)) and sidebar entry **📡 Real-Time** (between Backtest and Paper Traded History). Replaces the workflow of bouncing between six dedicated paper/live status pages just to see what's happening right now.
- **Single screen** with a **PAPER ⇄ LIVE** toggle at the top right (blue = paper, red = live). Polls every 4 seconds.
- **Three side-by-side cards** — SWING / SCALP / PRICE ACTION — each showing:
  - RUNNING / STOPPED / OFFLINE badge
  - Open position card: side (CE/PE), symbol, qty, entry spot, entry option LTP, current option LTP, live spot, points moved, stop loss, entry time, **unrealised P&L with %**
  - "FLAT — no open position" placeholder when no trade is active
  - Today's stat tiles: Trades, Wins / Losses, Session P&L
  - Footer: live LTP, last tick time, tick count
- **Rollup table below** — one row per strategy plus a **TOTAL** row, columns: Strategy, Status, Open P&L (unrealised), Closed P&L (today), Trades, W / L, **Today Total (Open + Closed)**. Everything is today-only — no cumulative-across-all-sessions number on this page.
- **Read-only** — no Start / Stop / Exit buttons. Drill-down still happens on the dedicated `/swing-paper`, `/swing-live`, etc. pages.
- **Theme-aware** — respects the global `UI_THEME` setting (Day / Night view) like every other page; full light-mode overrides for cards, rollup, stats, and toggle. Positive / negative P&L values stay green / red in both themes via `!important` semantic color classes (so light-mode `.rollup td { color:#334155 }` rules can't override the P&L coloring by selector specificity).
- **No new backend aggregation** — the page polls each strategy's existing `/{mode}-{paper|live}/status/data` endpoint in parallel from the browser, so it always reads the same source the dedicated status pages already use. Zero risk of divergence; one normalised key handles `unrealisedPnl` (swing) vs `unrealised` (scalp/PA).
- **Runs alongside live trading** — not in the sidebar's `blocked` list, so it's reachable while any live session is active (read-only, can't disturb broker state).

---

## v4.4.0 — Hybrid Initial SL Cap, Sync to Local, Restore Sessions, Live Paper-Parity (2026-04-27)

### Swing — Hybrid Initial SL Cap

- **`SWING_USE_PREV_CANDLE_SL`** (default `true`), **`SWING_MAX_INITIAL_SL_PTS`** (default `50`), **`SWING_MIN_INITIAL_SL_PTS`** (default `15`).
- Initial SL was previously always SAR-based (typically 100–130 pts wide on young trends), so a single losing trade could wipe out multiple winners. New logic in `_applyInitialSLCap()` takes the tightest of `[SAR, prev-candle structural low/high, entry ± MAX_PTS]` then floors at `MIN_PTS` to avoid suicide-tight SLs on doji bars.
- **Trail activation rescaled** — `TRAIL_ACTIVATE_PTS` now scales with the capped SL gap, so the env knob actually binds.
- **Wired into both Swing Paper and Swing Live** (`src/routes/swingPaper.js`, `src/routes/swingLive.js`); candle-close + intra-candle entry paths both go through the cap. Backtest is intentionally untouched during the paper-trade data-collection window.
- **Settings UI** exposes all 3 knobs in the Swing section.
- New trade-record field `sarStopLoss` preserves the raw SAR distance for paper-vs-live + paper-vs-historical analysis.

### Live — Paper-Parity Sweep

- **`/swing-live`** — adds `pauseUntil` + `MAX_DAILY_TRADES` guards on the candle-close entry path (intra-candle path already had them); wires `skipLogger` + `logNearMiss` across signal=NONE / VIX / spread blocks (both candle-close + intra-candle); adds `strength` to `notifySignal` payload.
- **`/scalp-live`** — ports `SCALP_TRAIL_GRACE_SECS` so first-tick noise spikes don't kill trades (matches paper); adds `entryTimeMs`; wires `skipLogger` + `logNearMiss` across the same gates.
- **`/pa-live`** — mirrors PA Paper's audit and skip-log wiring (strategy / VIX / spread gates), sharing the same `pa_paper_skips_*.jsonl` file as PA Paper.
- All three live engines now capture `signalStrength`, `vixAtEntry`, `entryHourIST`, `entryMinuteIST` at entry and surface them on the trade record at exit — feeding the active paper-trade data-collection schema.
- **Pure additive logging on PA strategy** — `result.filterAudit` (CE/PE × RSI / ADX / SR / Pattern) is populated on the no-signal path so JSONL skip logs capture *why* each bar produced no signal. `nearMissLog` now emits "🎯 NEAR-MISS" lines when a bar misses by exactly one filter. No threshold, pattern, RSI/ADX/SL, or signal logic changed.

### Dashboard — One-Click "Sync to Local"

- **`/sync/info`** + **`/sync/download-all`** — a Dashboard button now streams a `tar.gz` of `~/trading-data/` to the browser so the EC2 host's persistent trade data can be mirrored locally without SSH.
- Direction is **server → client only** (no upload path). Useful for local replay, off-EC2 backups, and cross-checking JSONL trade logs.

### Paper History — Restore Deleted Sessions

- **Restore button** next to each row in the Daily Data Files table on all 3 paper history pages (Swing / Scalp / PA). Reads the daily JSONL for that IST date, dedupes trades against any sessions already present (by `entryBarTime` / `entryTime`), and rebuilds a session containing only the missing trades.
- Works because JSONL trade logs are append-only and untouched by Delete Session — recovered sessions are tagged `restoredFromJsonl: true`.
- **Idempotent** — re-running on a fully-present date returns "Nothing to restore." Endpoints refuse while paper is running (mirrors the delete handler).
- Backed by new helper `readDailyTrades(mode, date)` in `src/utils/tradeLogger.js`.

### Settings — Schema Cleanup + Re-grouping

- **Drift fixed** — settings UI was diverging from code: a few schema fields had no readers, several env vars used in code had no UI, and two unimported scalp strategies still lingered in `src/strategies/`.
- Removed: `BACKTEST_GAMMA`, `ZERODHA_REDIRECT_URL` (no readers).
- Added: `PA_ENABLED`, `PA_OPT_STOP_PCT`, `GAP_THRESHOLD_PTS`, `LTP_STALE_FALLBACK_SEC`, `MAX_BID_ASK_SPREAD_PTS`, `TIME_STOP_CANDLES`, `TIME_STOP_FLAT_PTS` (now editable via UI).
- Removed from `IMMEDIATE_KEYS`: `BACKTEST_FROM`, `BACKTEST_TO`, `BACKTEST_GAMMA`.
- Deleted unused legacy strategies `src/strategies/scalp_ema9_rsi.js` and `scalp_ema9_rsi_v2.js` (active scalp strategy is `scalp_bb_cpr.js`).
- **Expiry override moved** from the Swing section to **Common — Instrument** in the Settings UI. Both `EXPIRY_OVERRIDE` and `EXPIRY_TYPE` are read by `src/config/instrument.js` for all 3 engines (Swing / Scalp / PA), so the prior placement under Swing was misleading. Pure UI re-grouping — keys, `.env`, and `IMMEDIATE_KEYS` classification unchanged.

### Consolidation — Date Normalization

- **`/consolidation` session date** normalized to `YYYY-MM-DD` so daily / monthly / yearly roll-ups are consistent across older sessions that previously stored dates in mixed formats. Equity curve and Day View both align on the canonical date format now.

### Startup — SSL-Cert Failure Hardening

- On SSL cert load failure (missing/invalid `certs/cert.pem` or `certs/key.pem`) the bootstrap now clears the Telegram crash-marker and skips the non-restart code path, so a misconfigured cert no longer triggers a phantom "recovered from crash" alert on the next boot.

### Misc UI / Bug Fixes

- **Eye-icon View button** on swing-paper-history rows is now wired through to the trade detail modal (parity with PA / Scalp).
- **Delete Session** on swing-paper-history now reloads cleanly (toast JS injected on delete) instead of leaving a half-rendered table.
- **Template-literal `\n` escape fix** on swing-paper-history rendering — long sessions no longer break copy-trade-log generation.

---

## v4.3.0 — Live Traded History, Per-Module Dashboard, Trade Guards, Audit Trails (2026-04-24)

### Live Traded History — Cross-Mode Live View

- **`/live-consolidation`** — unified live-trade history (Swing Live + Scalp Live + PA Live), parallel to the existing `/consolidation` (paper). Same Daily/Monthly/Yearly roll-ups, filters, equity curve, and bulk copy.
- **Sidebar entry** under "🔴 Live Traded History" (sibling to "Paper Traded History").
- **Per-mode `/reset` endpoints** — `POST /swing-live/reset`, `POST /scalp-live/reset`, `POST /pa-live/reset`. Reset buttons live on each live status page; gated when a session is active.
- **Toggle on dashboard** — the cumulative-P&L card switches between Paper and Live data sources, both feeding the same charts.

### Dashboard — Per-Module P&L Cards + Mutual Lock

- **Per-module cards** (Swing / Scalp / PA) — each card has a Paper/Live toggle, trades, win-rate, total-P&L stats, and its own cumulative chart.
- **Per-module charts** colored red/green by P&L sign (not by paper/live colour).
- **Hover-only date labels** on dashboard charts (x-axis decluttered).
- **Mutual lock** between *Start All Paper* and *Start All Live* — once one is running, the other is disabled and pulses to indicate active state. Prevents accidentally double-running across modes.
- **Start-all failures surface in a modal** instead of silent reload.
- **Side-by-side broker rows** (Fyers + Zerodha on one row), compact pro layout.

### Per-Module VIX Thresholds

- **`SCALP_VIX_MAX_ENTRY`, `SCALP_VIX_STRONG_ONLY`, `PA_VIX_MAX_ENTRY`, `PA_VIX_STRONG_ONLY`** — Scalp and PA now have independent VIX thresholds (not just enable/disable). Each falls back to the swing values if unset, so existing configs stay compatible.
- Documented in `.env.example`; surfaced in Settings.

### Trade Guards — Bid-Ask Spread + Time-Stop

- **`MAX_BID_ASK_SPREAD_PTS`** (default `2`) — block entry if option bid-ask spread is wider than N points. Fails *open* if quotes unavailable so live entries don't freeze on a missing feed.
- **`TIME_STOP_CANDLES`** (default `4`) + **`TIME_STOP_FLAT_PTS`** (default `20`) — auto-exit a trade that has stayed flat (|PnL| < flatPts) for N candles, to bail out of pure theta-bleed.
- **PA-specific overrides**: `PA_TIME_STOP_CANDLES=3`, `PA_TIME_STOP_FLAT_PTS=10` (tighter, since PA SL is also tighter).
- Shared in `src/utils/tradeGuards.js`, used by all 3 paper + live engines.

### Scalp — Trend Filter

- **`SCALP_TREND_FILTER`** (default `true`) — block BB breakouts against the prevailing direction (no CE in a downtrend, no PE in an uptrend). Reduces whipsaws in choppy zones.
- Tunables: `SCALP_TREND_MOMENTUM_PCT=0.15`, `SCALP_TREND_MOMENTUM_LOOKBACK=5`, `SCALP_TREND_MID_SLOPE_LOOKBACK=3`. BB-mid slope + N-candle momentum jointly classify direction.

### Price Action — Tightening (entries + SL + trail)

- **Capped per-trade loss** — strategy-layer SL now bounded by `[PA_MIN_SL_PTS=8, PA_MAX_SL_PTS=12]` during signal generation (route-level fallback remains 25).
- **Structural-SL skip** — `PA_MAX_STRUCT_SL_PTS=15`: reject BOS / Inside-Bar setups whose raw structural SL exceeds 15 pts (thin-structure / false-breakout guard).
- **PA time-stop** — flat exit after 3 candles / ±10 pts (overrides global 4 / 20).
- **Goal**: cap loss/trade and let winners run via the existing tiered trail + candle-trail stack.

### Price Action — Per-Pattern Toggles

- **8 individual pattern flags** replace the single `PA_CHART_PATTERNS_ENABLED` switch:
  - Core (default **on**): `PA_PATTERN_ENGULFING`, `PA_PATTERN_PINBAR`, `PA_PATTERN_BOS`, `PA_PATTERN_INSIDE_BAR`
  - Chart (default **off**): `PA_PATTERN_DOUBLE_TOP`, `PA_PATTERN_DOUBLE_BOTTOM`, `PA_PATTERN_ASC_TRIANGLE`, `PA_PATTERN_DESC_TRIANGLE`
- Each pattern is wired into the signal layer with its own conditional, so disabling one pattern at a time has zero effect on the others.
- **Inside Bar pending state** is dropped if the toggle is flipped off mid-session (no stale carry-over).
- All 8 toggles surfaced in **Settings → Price Action**.

### Per-Filter Near-Miss Audit

- **`src/utils/nearMissLog.js`** — every candle that *almost* triggered a trade (missed by exactly one filter) is logged with the failing filter name + detail. Wired into PA, Swing, and Scalp paper modes.
- View live in `/logs` SSE feed. Quantifies the opportunity cost of each individual filter for tuning.

### Crash-Safe JSONL Trade Log

- **`src/utils/tradeLogger.js`** — every trade exit appended (POSIX `O_APPEND`, atomic per-line) to:
  - `~/trading-data/{swing|scalp|pa}_paper_trades_log.jsonl` (cumulative)
  - `~/trading-data/trades/{swing|scalp|pa}_paper_trades_YYYY-MM-DD.jsonl` (per-day)
- **Async fire-and-forget** — trade-exit hot path is no longer blocked by I/O.
- **Per-day skip + trade JSONL** is downloadable from history pages (per-date).
- Survives crashes — no data loss vs the old session JSON flush-on-exit.

### Consolidation — Day View Panel

- **Day View** table on `/consolidation` (and matching panels on per-mode paper/scalp history) — chronological per-trade list with date, mode, entry/exit time, side, P&L; per-mode breakdown.
- **Pagination** on Day View on backtest + paper-history pages (no more 500-row scroll on long sessions).
- **Red/green tint** on P&L cells (cell background + row tint on consolidation, table-row tint on history).

### Sidebar — Accordion + Per-Feature Toggles

- **Accordion sections** (Swing / Scalp / PA) — only one expanded at a time; collapses cleanly.
- **Per-feature menu toggles** (env-driven, hidden by default to declutter):
  - `UI_SHOW_SIMULATE` (default `false`) — show "Simulate" link under each mode
  - `UI_SHOW_COMPARE` (default `false`) — show "Compare" link
  - `UI_SHOW_TRACKER` (default `false`) — show "Tracker" under Swing
- **Login Logs removed from sidebar** — moved to a top-bar button on the Settings page (still accessible at `/login-logs`).
- **Breadcrumbs** added to Settings, Monitor, Docs, P&L History, and Login Logs.
- **History button** on every paper status page (Swing/Scalp/PA) → jumps to that mode's history.

### Settings UI — Bulk Edit Modal + Delete-Key Support

- **"Bulk Update & Restart" modal** (button label `📋 BULK EDIT` in top-bar) — bulk paste was moved out of the page body into a focused modal.
- **Delete keys** — lines beginning with `-` (e.g., `-PA_MIN_RR`) remove keys from `.env` during bulk apply. Lets you prune dead config keys without manual file editing.
- **Reset & Save** button on each section was renamed for clarity (now scoped reset, not a global "reset everything").
- Quick Links (P&L History / Monitor / Docs / Login Logs) moved into top-bar buttons.

### Telegram — Crash + Startup-Recovery Alerts

- **Synchronous Telegram on shutdown** — `sendTelegramSync()` spawns `curl` so alerts survive `process.exit()` (previously fire-and-forget could be killed mid-flight).
- **Crash-marker file** — captures the error type + stack on uncaught exception / SIGTERM. On next startup, the marker is read and a recovery alert is sent (cause + uptime).
- **Startup recovery ping** also reconciles persisted positions vs broker positions and alerts on orphans.

### Operations / PM2

- **Heap caps restored** (`--max-old-space-size=900`, `max_memory_restart: 940M`) after a fix that was killing live paper trade.
- **Backtest engine memory footprint shrunk** — large date-range runs now fit comfortably under the t3.micro ceiling.
- **Monitor page maintenance actions** for safe in-app cleanup of caches/log dirs.
- **SIGTERM handler** fixed — was the root cause of silent restarts during nodemon/pm2 reload cycles.

### Misc UI / UX

- **Eye-icon View buttons** in swing-paper-history → trade-detail modal (parity with PA/scalp).
- **Copy Trade Log + Delete Session** moved into the session header (before PnL) on all paper-history pages.
- **Compact dashboard** — per-module start rows + single-line broker rows.
- **Light-theme overrides** for all-backtest + docs pages.
- **All-backtest 401** now surfaces an error modal instead of silent refresh loop.

---

## v4.2.0 — Live Charts, Consolidation, P&L History, Telegram Restructure (2026-04-20)

### Live NIFTY Candlestick Charts

- **Chart on status pages** — live candlestick chart rendered on all paper + live status pages (Swing / Scalp / PA), with real-time updates as candles close
- **Entry-logic overlays**: Bollinger Bands on scalp charts, swing highs/lows on PA charts — makes it visual *why* the engine took (or skipped) a signal
- **Entry/exit markers** on every session chart (arrows + strike + P&L)
- **Click trade row → focus chart on that trade only** (zooms to entry–exit window). Click again or the reset icon to restore full session view
- **Chart zoom preserved across refresh**, even when focused on a trade — no more losing context every 10 seconds
- **Light-theme modal contrast** fixed for chart trade-detail popups
- **`CHART_ENABLED` toggle** in Settings to show/hide the chart globally

### Consolidation Page — Cross-Mode Trade History

- **`/consolidation`** — unified view flattening every trade across Swing + Scalp + PA paper sessions
- **Roll-ups**: Daily / Monthly / Yearly P&L with per-mode breakdowns and equity curve
- **Filters**: mode, side (CE/PE), date range, symbol search
- **Bulk copy** (daily / weekly / monthly) + per-trade copy buttons
- Driven by the three `*_paper_trades.json` files — no extra persistence layer

### P&L History — Broker-Wise with FY Roll-up

- **`/pnl-history`** — consolidated realised P&L per broker (Kite + Fyers)
- **One-time past baseline** per broker (stored in `historical_pnl.json`) — set it once and forget; never FY-split, captures everything before the bot started
- **Live-bot overlay** — auto-computed from `live_trades.json` / `scalp_live_trades.json` / `pa_live_trades.json`, grouped by Indian FY (Apr–Mar)
- **Grand total** per broker + across brokers (baseline + live)
- Live totals update automatically as trades close — no manual reconciliation

### Telegram — 17 Toggles + Master Gate + Consolidated EOD

- **Master gate `TG_ENABLED`** — single switch to mute all alerts without losing per-mode config
- **17 per-mode toggles**: `TG_{SWING|SCALP|PA}_{STARTED|ENTRY|EXIT|SIGNALS|DAYREPORT}` + `TG_DAYREPORT_CONSOLIDATED`
- **Signal-skip alerts** per mode explain why a trade was/wasn't taken on candle close (when flat)
- **Consolidated EOD report** at 15:30 IST — one combined Telegram message across Swing/Scalp/PA covering trades, wins/losses, win rate, net P&L (weekdays only, scheduled idempotently)
- **Per-mode day report on session stop** preserved as a separate toggle

### Settings UI — Bulk Paste + Restart

- **Bulk Update section** — paste `KEY=VALUE` pairs (or `KEY: VALUE`, quoted, `#` comments), previews keys to update, then applies all + restarts server with one button
- Sensitive keys (SECRET/TOKEN/ACCESS) are auto-ignored from bulk paste
- **Restart Server button** — graceful `process.exit(0)` via `POST /settings/restart`, leverages PM2/nodemon auto-restart. Active sessions stop cleanly before exit
- **Frozen (disabled) rows** for dependent fields — VIX params freeze when VIX filter off, entire scalp section freezes when scalp mode off

### Scalp V4 — Quality Filters + Trail Grace

- **Approach filter** (`SCALP_REQUIRE_APPROACH`) — block entry if prev candle was on opposite half of BB (first-touch breakouts often fade; require the market to be *approaching* the band)
- **Body-strength filter** (`SCALP_MIN_BODY_RATIO`) — require entry candle body to be at least N% of its range (rejects doji / long-wick breakouts signaling exhaustion)
- **Trail grace period** (`SCALP_TRAIL_GRACE_SECS`) — suppress trail-exit for first N seconds after entry so a first-tick spike + tiny pullback doesn't kill the trade; initial SL still active throughout
- Both V4 filters are env-toggleable and **exposed in Settings UI** (disabled by default to preserve prior behavior)

### Dashboard — Start-All + PA Panels

- **Start-All Paper** / **Start-All Live** buttons — kick off every enabled mode (Swing + Scalp + PA) in one click, sequentially with per-mode confirmation
- **PA paper / live panels** on dashboard alongside Swing + Scalp (previously only Swing + Scalp were surfaced)
- Pickups hidden modes — if `SCALP_MODE_ENABLED=false` or `PA_MODE_ENABLED=false`, those panels and Start-All endpoints are excluded

### Session History — View Modal + Delete Session

- **View modal** on PA/Scalp history pages — full-session trade breakdown without leaving the list
- **Delete Session** button per session (Swing + Scalp + PA) — removes one session from history with confirmation
- Per-session copy trade log preserved

### Simulator Fidelity

- **Historical replay warmup bumped 30 → 300 candles** (swing/PA) — indicators reach steady state before the first replay candle, eliminating cold-start signal anomalies
- **Zigzag intra-candle ticks** — ticks now noisily zig-zag inside each candle instead of tracing a smooth O→H→L→C arc; slippage, wicks, and SL hits simulate far more realistically

### Price Action — BOS Tightening (reverted)

- Experimental BOS tightening (RSI caps + range filter + higher trail floors) was rolled back after backtest regression. Current PA logic = profit-lock + candle trail as the primary exit stack.

### Auth & Mobile

- **Login cookie uses `SameSite=Lax`** (was `Strict`) to fix mobile OAuth redirect loop during Fyers/Zerodha login flow

### Option LTP Polling

- **Rate-limit backoff** when broker throttles LTP requests — bot paces itself back instead of hammering
- **Spot-proxy trail fallback** — if option LTP goes stale mid-trade, trail logic falls back to a spot-proxy estimate so trailing doesn't freeze during a throttle window

### Docs

- **Backtest/Paper/Live mode documentation** with SVG diagrams + flowcharts describing the exact signal → entry → exit pipeline and where each mode diverges
- **Price Action guide v3.0** — candle trail, VIX regime, crash recovery sections added

---

## v4.1.0 — Background Backtests, Mode Rename, and Backtest Scaling (2026-04-16)

### Mode Rename: Swing / Scalp / Price Action

- **All trading modes renamed** for consistency: "Live Trade" → Swing Live, "Paper Trade" → Swing Paper, "Backtest" → Swing Backtest
- Route prefixes updated: `/trade` → `/swing-live`, `/paperTrade` → `/swing-paper`, `/backtest` → `/swing-backtest`, `/scalp` → `/scalp-live`
- Settings page section headers updated to SWING / SCALP / PRICE ACTION
- Route files renamed: `trade.js` → `swingLive.js`, `paperTrade.js` → `swingPaper.js`, `backtest.js` → `swingBacktest.js`, `scalp.js` → `scalpLive.js`, `priceActionLive.js` → `paLive.js`, `priceActionPaper.js` → `paPaper.js`, `priceActionBacktest.js` → `paBacktest.js`

### Background Backtests with Progress Bar

- Backtests now run in the background — browser no longer hangs on long runs
- Real-time progress bar with phase labels (Fetching, Computing, Rendering)
- One backtest at a time to protect server resources (`backtestJobManager.js`)
- Smart monthly caching — fetches candle data month-by-month with rate-limit delay + retry
- Progress page preserves from/to/resolution params across redirects

### Backtest Scaling & Performance

- **Optimized backtest engine** for 100K+ candle runs (large date ranges)
- **Split by Years checkbox** on all backtest pages — run each year separately with combined summary
- **Split by Months checkbox** on all backtest pages — granular month-by-month breakdown
- Queued split tabs instead of crashing server with concurrent backtests
- Random delay on queue page reload to prevent thundering herd
- Embedded trades capped to 2000 per page for browser performance
- Smaller yield batch size for backtest rendering

### Entry Signal & Analytics

- **Entry Reason Breakdown** analytics panel on backtest pages — shows distribution of entry signals
- **Entry Signal** field added to trade modals across all modes
- `entryReason` data tracked in scalp/PA backtest and live trade engines

### UI & Quality of Life

- **DD/MM/YYYY date format** across all pages (previously mixed formats)
- **HH:MM:SS time format** in date/time columns
- Per-session copy trade log on all history pages
- Eye icon summary modals now shown on all settings sections

### Code Quality

- **Shared trade utilities** extracted to `tradeUtils.js` — stateless pure helpers used across all trade routes
- **Production hardening**: graceful shutdown handler, shared `errorPage` template, PA mode tracking
- Backtest behavior aligned with paper/live across all 3 modes

### Bug Fixes

- Fix candles shim for HTML rendering in background job result path
- Fix rate-limit delay + retry for monthly cache API fetches
- Fix missing `fmtAna` function in PA and scalp backtest analytics
- Fix eye icon only showing on first two settings sections
- Fix trailing params and ADX/RSI caps that degraded PA backtest PnL
- Fix RSI caps removed from pattern checks; chart patterns disabled by default

---

## v4.0.0 — Price Action Strategy, Simulation Engine, and Full Platform Upgrade (2026-04-15)

### New Strategy: Price Action (5-min)

- **Strategy 3 — `PRICE_ACTION_5M`**: Pure price-pattern recognition on 5-min candles with RSI confluence
  - Patterns: Bullish/Bearish Engulfing, Pin Bar (Hammer/Shooting Star), Inside Bar Breakout, Break of Structure, Double Top/Bottom, Ascending/Descending Triangle
  - Dynamic S/R zones from swing highs/lows (last 30 candles, zone = swing ±10pts)
  - RSI confluence: CE requires RSI > 45, PE requires RSI < 55
  - SL = signal candle wick boundary
  - Full mode support: PA Live (`/pa-live`), PA Paper (`/pa-paper`), PA Backtest (`/pa-backtest`)
  - Fyers order placement for live mode

### Market Scenario Simulator

- After-hours paper trade testing with realistic tick generation
- 8 market scenarios: `trending_up`, `trending_down`, `choppy`, `volatile`, `breakout_up`, `breakout_down`, `v_recovery`, `inverted_v`
- Each scenario generates ~75 candles simulating a full 9:15–15:30 session
- Feeds ticks into the production `onTick()` pipeline — full strategy logic (SL, trailing, exit rules) runs identically to live
- Available for all 3 modes: `/paperTrade/simulate`, `/scalp-paper/simulate`, `/pa-paper/simulate`
- Historical date replay with 1-min candle tick replay for improved fidelity
- Resolution-aware simulated clock with correct timestamps and cooldowns

### Signal & Entry Improvements

- **ADX chop filter**: Skip entries when ADX < threshold (choppy market detection)
- **RSI overbought/oversold caps**: Block CE entries when RSI > 80, PE entries when RSI < 20
- **EMA30 filter toggle**: Optional medium-term trend gate (`EMA30_FILTER`)
- **Logic 3 CE override**: Captures lagging-SAR bullish entries that classic logic misses
- **Signal rejection breakdown**: Detailed analytics showing why signals were rejected (both trading and scalp backtest)
- **BB squeeze filter**: Skip scalp entries when Bollinger Bands are narrow (low volatility)
- **Consecutive SL escalation**: Widen SL after consecutive losses to avoid whipsaw
- **Rebalanced trailing**: Improved trail activation and gap defaults

### Scalp Strategy Enhancements

- **Tiered trailing profit**: Keep more as profit grows (₹500→55%, ₹1000→60%, ₹3000→70%, ₹5000→80%, ₹10000→90%)
- **PSAR trailing SL**: Only tightens, never widens; PSAR flip = immediate exit
- **SL source tracking**: Exit reasons now show whether SL was PSAR-based or Prev Candle-based
- **Previous candle SL** restored as default (replaced short-lived ATR-based SL experiment)
- **Default resolution changed from 3-min to 5-min** for scalp mode
- **VIX filter fully decoupled**: Separate `SCALP_VIX_ENABLED` toggle independent of trading VIX
- **Look-ahead bias eliminated** in scalp backtest — entries now on next candle open
- **SL recalculated relative to actual entry price**; gap-past entries skipped

### Capital Protection & Risk Management

- **Hard SL layer**: Additional absolute stop-loss as a safety net
- **Crash recovery**: Active positions persisted to disk (`~/trading-data/`); orphan detection + Telegram alert on restart
- **Staleness alerts**: Warns if data feed goes stale during active position
- **Health check button** on Settings page with status modal

### UI & Dashboard

- **Paper vs Backtest comparison page** (`/compare/trading`, `/compare/scalping`) — side-by-side metrics: total trades, win rate, PnL, max drawdown, equity curve
- **EC2 instance health monitor** (`/monitor`) — real-time CPU, RAM, disk, load average, uptime charts
- **Analytics panels** on both trading and scalp backtest pages — win/loss distribution, streak analysis, time-of-day performance
- **Detailed loss analytics** in scalp backtest
- **Day view summary table** with copy buttons on backtest pages
- **Day/night theme toggle** — hand-crafted light theme with proper CSS (replaced initial filter-invert approach)
- **Collapsible accordion sections** on settings page
- **Eye icon summary modals** for trading & scalping settings (with copy button)
- **Env key name display** after effect badge in settings UI
- **GitHub Actions deploy status widget** — floating chip in bottom-right, webhook-driven (`/deploy/webhook`)
- **Simulate links** added to sidebar navigation
- **Per-session delete button** and copy trade log in scalp history
- **Chart.js colors now theme-aware** across all pages
- **Auto-refresh** on scalp pages when returning from background tab

### Backtest & Analytics

- **Disk cache for candle data** (`~/trading-data/backtest_cache/`) — reduces Fyers API calls, 90-day auto-prune
- **Backtest-style analytics** added to paper trade screens (copy trade log, day view)
- **Candle pre-load extended** from 7 to 21 days to match backtest indicator depth
- **Default backtest range** set to current month (ignores `BACKTEST_FROM/TO` env vars)

### Configuration & Settings

- **Configurable entry start/end times** for both trading and scalping
- **Configurable strategy thresholds** via Settings UI — dynamic trail activation, tighter defaults
- **STT charges updated to April 2026 rates** with configurable settings
- **Fyers-specific charge rates** — STT 0.15%, exchange txn 0.0445%
- **Expiry-day-only toggle** for both trading and scalping modes
- **NIFTY weekly expiry updated** from Thursday to Tuesday

### Infrastructure & Operations

- **Comprehensive operational logging** across broker, socket, persistence, and VIX layers
- **NSE holiday API integration** with 2026 fallback list (`/api/holidays`, `/api/expiry-dates`)
- **Docs viewer** (`/docs`) — renders README, CHANGELOG, and documents folder as styled HTML
- **Login logs** with GPS + IP-API geolocation for failed attempts (`/login-logs`)
- **PM2 auto-start** on EC2 reboot via `pm2 startup`
- **SSH deploy action pinned** to v4.1.9 for stability
- **Improved shutdown Telegram messages** distinguishing live vs paper modes
- **IST conversion optimized** — replaced expensive `toLocaleString` with fast arithmetic across hot paths

### Bug Fixes

- Fix simulation vs paper trade result mismatches across all 3 routes
- Fix simulation fidelity with 1-min candle tick replay
- Fix R:R calculation in backtest — use spot points instead of ₹ for reward
- Fix `vix.toFixed` crash in scalp backtest by calling `lookupVix()`
- Fix live scalp PSAR window alignment with paper/backtest (completed candles only)
- Fix option expiry date calculation edge cases
- Fix strike selection rounding
- Fix socket teardown when second mode starts; fix backoff loop
- Fix duplicate bar bug on scalp paper UI
- Fix trailing profit lock — protects one step below peak instead of at peak (then reverted to lock at reached level)
- Fix manual entry SL when only 1 candle exists
- Fix `modalJS` isolation into separate script tag from trade data
- Fix zero-PnL trades counted as neutral, not losses
- Fix `candlesHeld` count after trail updates in backtest
- Fix scalp paper/live option polling alignment to 1s
- Fix backtest page future month block

---

## v-final-3 — Full Consistency Sync: Backtest + Live → Paper Trade Reference (2026-03-29)

### Summary
Complete audit of all three modes (Backtest, Paper Trade, Live Trade).
Found **7 logic differences** — 1 critical bug, 2 high-impact gaps, 4 missing risk controls.
Paper Trade is now the reference implementation. All modes behave identically.

---

### CRITICAL FIX — Trail 50% Floor/Ceiling Swapped in Backtest

**File:** `src/services/backtestEngine.js`

**Before (BUG):**
```js
// CE trail: Math.min → took the LOWER value = trail gets stuck at entryPrevMid
const effectiveTrailSL = position.entryPrevMid !== null ? Math.min(trailSL, position.entryPrevMid) : trailSL;

// PE trail: Math.max → took the HIGHER value = trail gets stuck at entryPrevMid
const effectiveTrailSL = position.entryPrevMid !== null ? Math.max(trailSL, position.entryPrevMid) : trailSL;
```

**After (FIXED — matches paper/live exactly):**
```js
// CE trail: floor = trail cannot sit BELOW entryPrevMid
const clipped = fiftyPctFloor !== null && trailSL < fiftyPctFloor;
const effectiveTrailSL = clipped ? fiftyPctFloor : trailSL;

// PE trail: ceiling = trail cannot sit ABOVE entryPrevMid
const clipped = fiftyPctCeiling !== null && trailSL > fiftyPctCeiling;
const effectiveTrailSL = clipped ? fiftyPctCeiling : trailSL;
```

**Impact:** Winning trades in backtest were not locking in profits correctly.
CE trail SL was capped *down* at entryPrevMid — never tightened past it.
PE trail SL was capped *up* at entryPrevMid — never tightened past it.
Backtest results were non-representative of live/paper trailing behaviour.

---

### HIGH FIX — SL Hit Detection Changed from candle.close to candle.low/high

**File:** `src/services/backtestEngine.js`

**Before:** `candle.close < position.stopLoss` (SL only hit if candle CLOSES below SL)
**After:** `candle.low <= position.stopLoss` for CE, `candle.high >= position.stopLoss` for PE

**Why it matters:** Paper/live check SL on every tick. A candle can wick through SL
and recover by close — backtest used to survive this, paper/live would exit.
Using `candle.low`/`candle.high` as intra-candle proxy now matches tick-by-tick behaviour.
Backtest was previously overstating win rate by ignoring wick SL hits.

---

### HIGH FIX — 50% Entry Gate Added to Live Trade

**File:** `src/routes/trade.js`

**Before:** Live trade had NO 50% entry gate. Paper trade had it since simulateBuy().
**After:** Both candle-close and intra-candle entry paths now check:
```js
const violates = (side === "PE" && spot > entryPrevMid) ||
                 (side === "CE" && spot < entryPrevMid);
if (violates) { /* block entry — no directional room */ }
```

**Why it matters:** Without this gate, live trade could enter trades where the 50% exit
rule would fire on the very first tick — a guaranteed loss. Paper trade already blocked
these entries. Live was taking trades that paper would never take.

---

### 50% Entry Gate Added to Backtest

**File:** `src/services/backtestEngine.js`

Same 50% entry gate logic added before entry creation.
Previously had a comment explaining why it was intentionally skipped —
but this caused backtest to take trades that paper/live would never take.

---

### Risk Controls Added to Backtest (4 features)

**File:** `src/services/backtestEngine.js`

All 4 risk controls now match paper trade:

| Control | Paper | Backtest (before) | Backtest (after) |
|---|---|---|---|
| Daily loss kill switch (MAX_DAILY_LOSS) | ✅ | ❌ Missing | ✅ Added |
| Max daily trades cap (MAX_DAILY_TRADES) | ✅ | ❌ Missing | ✅ Added |
| Consecutive loss pause (3 losses) | ✅ | ❌ Missing | ✅ Added |
| Same-candle SL re-entry block | ✅ | ❌ Missing | ✅ Added |

All use the same env vars: `MAX_DAILY_LOSS=5000`, `MAX_DAILY_TRADES=20`.
3 consecutive losses on 15-min: kills the day. On 5-min: pauses 4 candles.
SL re-entry block: only fires on initial SL hit (not trailing SL exit).

State variables reset at start of each new trading day in the backtest loop.

---

### Behaviour Matrix After This Release

| Feature | Live | Paper | Backtest |
|---|---|---|---|
| Signal logic (getSignal) | Same ✅ | Same ✅ | Same ✅ |
| Trail 50% floor/ceiling | Correct ✅ | Correct ✅ | **Fixed** ✅ |
| SL hit detection | tick-by-tick ✅ | tick-by-tick ✅ | **low/high proxy** ✅ |
| 50% entry gate | **Added** ✅ | Has it ✅ | **Added** ✅ |
| `TRAIL_ACTIVATE_PTS` default | 15 ✅ | 15 ✅ | 15 ✅ |
| Dynamic `trailActivatePts` (25% SAR gap) | ✅ | ✅ | ✅ |
| Tiered trail gap (T1/T2/T3) | ✅ | ✅ | ✅ |
| `_slHitCandleTime` skipped on trail exit | ✅ | ✅ | **Added** ✅ |
| `_slHitCandleTime` skipped on 50% exit | ✅ | ✅ | N/A |
| Daily loss kill switch | ✅ | ✅ | **Added** ✅ |
| Consecutive loss pause | ✅ | ✅ | **Added** ✅ |
| Max daily trades cap | ✅ | ✅ | **Added** ✅ |
| `initialStopLoss` stored on position | ✅ | ✅ | ✅ |
| `trailActivatePts` stored on position | ✅ | ✅ | ✅ |

---

### Files Changed

| File | Changes |
|---|---|
| `src/services/backtestEngine.js` | 6 fixes (trail bug, SL detection, 50% gate, 4 risk controls) |
| `src/routes/trade.js` | 1 fix (50% entry gate on both entry paths) |
| `src/routes/paperTrade.js` | No changes (reference implementation) |

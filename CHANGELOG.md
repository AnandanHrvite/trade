# Changelog

All notable changes to the Palani Andawar Trading Bot are documented in this file.

---

## Unreleased

### Added — the daily backup can push itself to Google Drive

The daily `.tar.gz` was only ever written to `~/trading-data/_backups/` on the same EC2 box it protects, and the banner nagged until you downloaded it by hand. Miss a few days and the only copy of that data is on the instance you're insuring against.

- **Settings → Backup & Restore → Google Drive**: connect a Google account once and every daily snapshot is uploaded to Drive immediately after it's cut. Not connected = nothing is uploaded, exactly as before. Disconnect stops it again; files already on Drive are left alone.
- Connecting uses Google's **device flow** — the card shows a short code you approve at google.com/device. The redirect-based flow isn't usable here: the app is served from `https://<ec2-ip>:3000` with a self-signed cert, and Google refuses redirect URIs that are raw IPs. No SSH and no public domain needed.
- Scope is **`drive.file` only** — per-file access to files this bot created, so it can never read or delete anything else in the Drive. It's also a non-sensitive scope, so the OAuth client needs no Google verification review.
- **☁ Backup to Drive now** button for a manual push (it cuts today's snapshot first if there isn't one yet), alongside the existing "Snapshot now" / "Download latest".
- Failures are surfaced **in the page**: a red strip inside the card carries the last upload error with its timestamp, so a failed *automatic* 16:00 push is visible next time the card is opened rather than only in the logs. `BACKUP_TG_ENABLED` heartbeats now carry the Drive result too.
- Credentials + refresh token live in `~/trading-data/.google_drive.json` (mode 0600), not `.env` — and that file is **excluded from the backup archive**, so a snapshot can never carry your Drive token off the box. Uploads are resumable-session based and the folder is pruned to `GDRIVE_RETAIN` (default 30) newest files. New keys: `GDRIVE_FOLDER_NAME`, `GDRIVE_RETAIN`. No new npm dependency.

### Fixed — the Dashboard's broker wallets ignored the Range filter

Picking "This month" narrowed every chart and stat on the Dashboard except the two numbers at the very top: the Fyers and Zerodha wallets kept quoting **all-time** paper P&L. A range-filtered curve sitting under an all-time wallet reads as a contradiction — the page appeared to disagree with itself about the same trades.

- The wallets were built server-side from each paper-trade file's `totalPnl`, a single all-time aggregate with no per-trade dates in it, so no range could ever be applied. The delta is now summed client-side from the **same trade list the charts already load** and narrowed with the **same** `_applyDashRange`, so wallet and curve cannot quote different periods.
- Each broker keeps its own strategy list — Zerodha = EMA_RSI_ST + EMA9+VWAP, Fyers = BB_RSI + PA + ORB, enabled strategies only — so a wallet still moves only for the strategies that actually trade through it. Unchanged from before; only the date window is new.
- The wallet renders as the pool alone with a `…` delta until the trades land, rather than flashing an all-time figure under a "This month" label. The tooltip now says "paper P&L over the selected range".
- Removes the now-unused `_readPnlCached` mtime cache from [app.js](src/app.js).

### Changed — Consolidation Report uses the shared Range dropdown

`/consolidation-report` still had its own nine-option list (All time · This week · Last week · This month · Last month · Last 7 days · Last 30 days · This FY · Custom) while the Dashboard and Edge Analytics had moved to the shared five (This month · Last month · Current week expiry · All · Custom). The same words could mean different dates on different pages.

- The page now renders `dateRangeOptionsHTML()` and resolves bounds through `drRange()` from [sharedNav.js](src/utils/sharedNav.js), so **"This month" means one thing across the whole app** — including the IST-anchored month boundary the page's own `new Date()` maths got wrong for a browser outside IST.
- Default range is **This month**, matching the Dashboard, instead of All time.
- "Current week expiry" resolves off the NSE expiry calendar (lazily fetched on first use, as elsewhere), so a holiday-preponed weekly is handled.
- The printed "Period:" line reads the selected option's own text instead of a private label map — the drift that let the two lists diverge in the first place. The page-local `ymd`/`fyStart`/`mondayOf` helpers are gone.

### Fixed — GAPS backtest failed with "Invalid input" (daily history exceeded the Fyers 366-day cap)

`/gaps-backtest` failed at 40% on any normal range. Fyers rejects a **1D/1W/1M** history request wider than 366 days (`{code:-50, message:"Invalid input", data:{range_to:"Date range cannot exceed 366 days…"}}`), and GAPS asked for one 580-day daily call — its own 400-day indicator warm-up plus the 180-day default range.

- **The session filter was deleting the entire daily series.** `fetchCandles()` keeps only 09:15 ≤ IST < 15:30 bars to strip pre-open auction and post-close prints. Fyers stamps a 1D/1W/1M bar at midnight IST, which is outside that window, so **every daily bar was dropped** and callers got an empty array — GAPS then failed with "Only 0 daily candle(s)". The filter is now intraday-only; a daily bar has no pre-open print to strip. This also silently affected prev-day OHLC in BB_RSI/PA paper+live and the VIX daily lookup in backtests, both of which were always receiving `[]`. No decision logic changes: `prevDayOHLC` is passed to `getSignal` but no strategy reads it, and the VIX gate is only consulted when `VIX_ENABLED` is on.
- `maxDaysForResolution()` in [backtestEngine.js](src/services/backtestEngine.js) returned `365 * 10` for daily, so **only intraday requests were ever chunked**. It now returns 366; `fetchCandles()` already walks contiguous chunks and dedupes by timestamp, so the returned series is identical — just split across calls. Long-range daily fetches now work for every strategy, not only GAPS.
- The same bug was silently breaking **GAPS Paper**: its 400-day daily fetch is inside a `try/catch`, so the rejection surfaced only as "Daily context unavailable" and the strategy could never arm. It goes through the same `fetchCandles()`, so the chunking fix covers it — no paper logic touched.
- GAPS backtest now uses the **same warm-up convention as the other backtests** (emaRsiSt / ema9vwap): 150 calendar days of daily history computed in IST, instead of its own 400-day `toISOString()` window. That is ~103 trading sessions — ample for the ~35 closed bars RSI(14)-on-EMA21 needs. The 150 is a *floor*: because GAPS's requirement scales with the configured lengths (Settings allows EMA up to 200 / RSI up to 100), the runway grows with `needDaily` so a raised length can no longer under-fetch and fail with "Only N daily candle(s)".

### Changed — token clearing is automatic; "Reset Token" button removed

The Dashboard's 🔄 **Reset Token** button is gone. It was a manual chore for something the app already does on a schedule, and it also restarted the server, which is far more than "clear my token".

- **Clicking a Login button now wipes the stale token first.** `GET /auth/login` and `GET /auth/zerodha/login` clear the saved token of every broker that is currently **disconnected**, then start OAuth. So a dead token can no longer be restored from disk on the next boot and show a broker as connected when it cannot trade.
- **A connected broker's token is never touched.** Logging into Fyers cannot knock out a working Zerodha session (and vice-versa), and a "re-login" on a still-valid session keeps the old token usable until the callback writes the new one. That also makes the clear safe to run mid-session — nothing a running engine depends on can be cleared by it.
- The scheduled clears are unchanged and unaffected: **4:00 PM IST** clears both tokens, **7:00 AM IST** clears both and restarts the process, and on boot each loader still discards a token saved on a previous IST day (or older than 20h).
- `POST /admin/reset` (clear both + restart, API_SECRET-gated) still exists for the rare stuck-socket case; it just no longer has a button on the Dashboard.

### Added — GAPS strategy guide

`documents/GAPS_Strategy_Guide.html`, the seventh guide, matching the format of the existing six: plain-English rules, a glossary, worked numbers, the full settings table and an explicit "what's still missing" section.

- Three inline SVG charts using the same copy-pasted `TVChart` kit as the other guides — the daily setup (EMA21 with RSI pinned at the extreme, then the gap down), the 5-minute session (entry, the moving trail, the exit) and a rejected day where the gap went the same way as the trend.
- **The chart data is generated by running the real engine**, not hand-drawn, so the pictures cannot contradict the code: the EMA21 overlays are `computeDaily`/`computeTrailEma` output and the exit bar is where `trailExitHit` actually fires. Every figure quoted in the prose was then checked back against that output (74pt gap, stop 25,628.49, exit 13:10 at 25,357.45 against a trail of 25,354.56, day's low 25,325.52).
- The settings table is generated from the live Settings schema, so it cannot drift from the UI.
- Registered in [docs.js](src/routes/docs.js) both ways: `GUIDE_MODE_BY_FILE` hides it from `/docs` when `GAPS_MODE_ENABLED=false` (verified by booting with the toggle off), and a `LIVE_CONFIG` entry injects the live toggle panel in place of the `<!--LIVE_STATUS_PANEL-->` marker.
- Charts QA'd by executing the guide's own script blocks in a node `vm` with a browser-like context: all three render valid SVG with no `NaN`/`undefined` in the output.

### Changed — GAPS judges the entry on TODAY's RSI, not yesterday's

Respecified: "RSI has to be checked current day only, with source as EMA". The two halves of the entry now read **different days** — the RSI is **today's**, while the gap is still measured against **yesterday's close**.

- **Today's RSI** is the daily RSI including today's bar. At 09:15 that bar has exactly one price, today's open, so it is built from the open: `computeTodayRsi()` appends a synthetic daily bar at the open to the closed history and recomputes EMA + RSI over it. Source stays `GAPS_RSI_SOURCE=ema` (RSI on the EMA21 line).
- Using the **open** rather than the live spot is deliberate and load-bearing. It is the price the rest of the decision already rests on, it is fixed the instant the market opens, and it makes Paper, Live, Backtest and Replay compute the identical number. A live-spot RSI would drift second by second and could never be reproduced in Replay — which would break the rule that Replay and Paper must decide identically.
- This genuinely changes decisions, it is not a relabelling: a gap large enough to bend the EMA moves today's RSI off yesterday's value, and a gap that drags it back inside the band is now correctly rejected. Covered by a regression test.
- The Paper page's **daily chart** is rebuilt the same way — closed history plus the synthetic open bar — instead of computing its own RSI over the raw broker series. That mattered: the raw feed may or may not carry today's forming daily bar, and when it does its close is the live price, not the open. On a worked example the old chart would have drawn RSI **92.26** while the entry was judged on **86.67** — opposite sides of the 90 band. The chart's last point is now, by construction, the number that decided.
- **No look-ahead**, pinned by tests: the closed history the RSI extends always stops before today, so feeding the engine a daily series that already contains today's bar — closed +850 or −850 — produces the identical RSI and the identical signal. Only today's *open* can ever influence it.
- `prevRsi` is still computed and reported everywhere for reference; `todayRsi` is what the entry is judged on, and it is what the trade record, the JSONL export, the status feed and the tables now show. Before the open the Paper page falls back to yesterday's value and **labels it provisional** rather than implying the decision is settled.

### Changed — GAPS stop is the gap SIZE from the fill, not the gap-fill level

Respecified: "that GAP POINTS is the base SL". The stop is now a **distance** — the size of the gap — applied to the price actually filled, rather than a fixed level at yesterday's close.

- PE (after a gap down) is stopped `gap` points **above** the fill; CE (after a gap up) `gap` points **below**.
- Filling at the open the two are identical, since `open ± gap == prev close`. They diverge when the fill is a little later inside the `09:15–09:30` window: the old rule let risk stretch toward yesterday's close, the new one keeps it pinned at the gap. Prev close 24,800, open 24,750 (50pt gap) → fill at 24,750 stops at 24,800; fill at 24,730 stops at 24,780, still exactly 50pt.
- Entry conditions are unchanged (RSI > 90 with a gap DOWN → PE; RSI < 10 with a gap UP → CE), as is the EMA trail and the 15:15 square-off.
- The rule lives in one place, `stopFromFill()` in [gaps.js](src/strategies/gaps.js), used by the engine, Paper and Backtest. The engine also publishes `slPts` so every surface reports the same risk figure instead of recomputing it from the fill.
- **Refuses to trade without a stop**: if the level cannot be computed the entry is aborted and a `stop_uncomputable` skip is logged, rather than opening a position the exit path would then never stop out.
- **Guarded**: `stopFromFill` rejects a non-numeric fill or distance and returns `null` rather than a level — `Number(null)` is `0`, so a coercing implementation would have produced a stop of `slPts`, which the first tick is already past. Both exit paths now also refuse to treat a null level as a hit, because `spot >= null` evaluates as `spot >= 0` and would square the trade off instantly.

### Changed — GAPS exit is a trailing EMA stop, not a fixed target

The exit was specified again and it is a **trailing stop**, so the fixed daily-EMA21 target is gone. Entry is untouched (RSI > 90 with a gap DOWN → PE; RSI < 10 with a gap UP → CE), and so is the gap-fill stop and the 15:15 square-off.

- **Old**: the daily EMA21 was pinned at 09:15 as one fixed price for the session, and the trade exited when a 5-min candle closed through it **in favour**. A daily EMA does not move during the day, so nothing trailed.
- **New**: `EMA(GAPS_TRAIL_EMA_LENGTH=21)` on the **intraday** `GAPS_EXIT_TF=5`-minute candles. The trade rides while price stays on the winning side and exits when a candle closes back **through** it — a PE on a close **above**, a CE on a close **below**. The EMA is recomputed every candle, so the exit level moves with price. Note this is the **opposite** comparison to the old target, not just a different level.
- `GAPS_TARGET_ENABLED` → `GAPS_TRAIL_ENABLED`; a key named "target" controlling a trailing stop would have been a lie. New `GAPS_TRAIL_EMA_LENGTH`, deliberately **separate** from `GAPS_EMA_LENGTH`: the latter is the *daily* EMA feeding the RSI ("EMA: EMA" source), and tuning the RSI smoothing must not silently move the stop. Both default to 21.
- The trail EMA runs over a **continuous multi-day** intraday series, so it is warm at 09:15 instead of taking ~105 minutes to form. Paper already preloaded 5 days; the backtest now computes the EMA once across the whole range and looks it up per bar, rather than restarting each morning — computing it per-day would have made the backtest exit differently from Paper for the first 21 bars of every session. When the trail genuinely is not warm the route logs it, because until then the gap-fill stop is the only exit.
- One rule, one place: `computeTrailEma()` and `trailExitHit()` live in [gaps.js](src/strategies/gaps.js) and are called by Paper, Backtest, the chart feed and (via Paper) Live and Replay. The **Paper and Live** intraday charts both plot the trail from the same engine call the exit uses, so the green line is literally the level that would close the trade — and the Live page's rule text, chart title and legend describe the trail rather than the retired target.
- **Behaviour change worth knowing**: on a steady adverse drift the trail now exits *before* the gap fills, capping the loss earlier than the old stop-only path. Covered by a regression test.
- Paper recomputes the trail over its rolling candle buffer while the backtest computes it once over the whole range, so the two only agree once the EMA has outrun its seeding transient. Measured on EMA21: ~1.5pt out 40 bars in, ~0.2pt at 60, and exactly 0 (to 2dp) by 100. The buffer is therefore kept at 300 bars, and the intraday preload lookback now **scales with `GAPS_EXIT_TF`** — a fixed 5 days yielded ~375 bars at 5-min but only ~31 at 60-min, which would have started the trail inside its transient and made Paper disagree with Backtest. Every supported timeframe now preloads ≥150 bars, and a short preload logs a warning instead of failing silently.

**Validation**: 67 assertions pass (20 new, covering EMA alignment and warm-up, both sides of the trail rule, stop-tested-before-trail, trail-beats-stop on a drift, a falling PE not being trailed out, trail disabled, and a non-default trail length). Booted twice to confirm the settings are live end-to-end: `GAPS_TRAIL_EMA_LENGTH=8` with `GAPS_EXIT_TF=15` moved the strategy config **and** the chart feed together. Still **not market-validated** — no paper session has run.

### Added — GAPS: a new strategy (extreme daily RSI + a next-day gap the other way)

A seventh strategy, built to the same standard as the other six — Settings section, sidebar group, Paper, Backtest, Live-via-harness, Replay, History, Analytics, Reports, Export, Telegram, logs, charts, dashboard card, real-time monitor. No existing strategy's behaviour changed.

**The rules, in full** — deliberately minimal; no trend filter, volume, ADX, VWAP, OI, confirmation candle or multi-timeframe logic was added.
- Indicators, both on the NIFTY **daily** series: `EMA(GAPS_EMA_LENGTH=21)` of close, and `RSI(GAPS_RSI_LENGTH=14)` whose input source is configurable and defaults to **`ema`** — RSI computed over the EMA21 line rather than close. That is TradingView's "EMA: EMA" source; double-smoothing is what lets RSI actually reach 90 / 10.
- Entry, decided **once at the open**: yesterday's daily RSI > `GAPS_RSI_UPPER=90` **and** today opens below yesterday's close → **BUY PE**; yesterday's RSI < `GAPS_RSI_LOWER=10` **and** today opens above yesterday's close → **BUY CE**.
- Stop = yesterday's close exactly (the gap-fill level), on spot, per tick.
- Target = the daily EMA21 of the last closed daily bar, pinned as a fixed level for the session; fires when a `GAPS_EXIT_TF=5`-minute candle **closes** through it in favour. `GAPS_TARGET_ENABLED=false` runs stop-and-EOD only. *(Superseded before release — see "GAPS exit is a trailing EMA stop" above.)*
- Nothing else exits: no breakeven, no time stop. Anything open is squared off at `GAPS_FORCED_EXIT=15:15`.
- Slightly-ITM strike (`GAPS_ITM_STEPS=1`). Risk: `GAPS_MAX_DAILY_TRADES=1`, `GAPS_MAX_DAILY_LOSS=5000`, `GAPS_MAX_WEEKLY_LOSS` (rolling Mon→today, off by default), `GAPS_LOSS_STREAK_SKIP=3`, plus the shared portfolio cap.

**One engine, four surfaces.** [src/strategies/gaps.js](src/strategies/gaps.js) is the only place the rules exist. Paper ([gapsPaper.js](src/routes/gapsPaper.js)) is canonical; Backtest ([gapsBacktest.js](src/routes/gapsBacktest.js)) calls the same `getSignal` and only re-implements the paper exits; Live ([gapsLiveHarness.js](src/routes/gapsLiveHarness.js)) *is* Paper wrapped by the shared harness, so Live = Paper by construction; Replay drives the paper route through recorded ticks.

**Correctness details worth recording**
- "Yesterday" is resolved by IST day number, so today's forming daily bar can never leak into the signal — the same bar is read in Paper, Live, Backtest and Replay. If the daily indicator series doesn't end on that bar (a history hole), the engine refuses rather than quoting a stale RSI as if it were yesterday's.
- Indicator alignment is explicit and verified: `EMA(p)` over N values yields N−p+1 points mapping to `values[i+p−1]`; `RSI(L)` over M values yields M−L points mapping to `values[j+L]`. With the default `ema` source that means ~35 closed daily candles are needed before the first signal — the route reports warmup instead of guessing.
- Today's open is taken from the daily bar's open where available, then the first intraday candle, then the first tick — and the source is recorded on the trade, so a session started late is visibly *not* using the official open.
- The backtest's intra-bar ordering is conservative: the gap-fill stop is tested on the bar's high/low **before** the target is tested on the close, and a bar that opened beyond the stop fills at the open, never at the better level.
- The Paper page's daily chart (candles + EMA21 + an RSI pane with the 90/10 band lines) is served from the same engine that produced the decision, so the chart cannot disagree with the trade.
- `positionPersist` now covers GAPS (`.active_gaps_position.json`), reconciled against the Fyers book on boot like the other Fyers engines.
- Per-strategy sizing (`GAPS_LOT_MULTIPLIER`) divides `getLotQty()` back down by the multiplier that function **actually applied** — it clamps to `MAX_LOT_MULTIPLIER` internally, so dividing by the raw `LOT_MULTIPLIER` recovered the wrong lot size whenever the global value exceeded the ceiling.
- `GAPS_MAX_WEEKLY_LOSS` reads the per-day JSONL logs, substituting the in-memory session for today's file **only while a session is running** (`appendTradeLog` writes the day file asynchronously, so the file lags; but when idle `state.sessionPnl` can hold a rehydrated *previous* session, which would otherwise be double-counted).
- A failed entry attempt (option LTP unavailable, expiry unresolved) no longer burns the day: the decision is locked only once a position exists, and a failure retries inside `GAPS_ENTRY_END`, throttled to one attempt per 5s. The pre-`await` guards are all synchronous, so concurrent ticks still cannot open two positions.

### Fixed — Replay served intraday warm-up candles to DAILY-resolution requests

Not GAPS-specific — this is the shared replay harness, and it is why the fix is recorded separately.

`tickReplay.install()` stubs `fyers.getHistory`, `backtestEngine.fetchCandles` and `candleCache.fetchCandlesCached` to return the recorded warm-up so a run is deterministic and never hits the broker. Those stubs **ignored the requested resolution**. That was harmless while every strategy asked only for 3/5/15-min bars, but GAPS reads a daily EMA/RSI and yesterday's daily close: under replay it would have been handed 5-minute candles, computed EMA21/RSI14 over them and called one of them "yesterday's close" — decisions that look plausible, are meaningless, and silently break the rule that Replay and Paper must decide identically.

- `D` / `W` / `M` requests now fall through to the real fetcher. Safe precisely because a **closed daily bar is immutable** — fetching it today returns exactly what the recorded session saw. Every intraday path is byte-for-byte unchanged, so the other six strategies replay as before.
- Defence in depth in the engine: `getPrevDaySnapshot` verifies the series really is daily (at most one bar per IST day) and refuses with an explicit reason rather than computing a daily indicator over intraday bars. This guards every caller, not just the replay harness.

### Fixed — GAPS day-log files were written but never served

GAPS wrote both per-day files from the start (`skipLogger` / `tradeLogger` mode `gaps`) but did not expose the two endpoints `/realtime` fetches, so its card sat on "— No Day Log —" while the files existed on disk — the same defect the recent ORB pass fixed. Added `/gaps-paper/download/trades/:date` and `/download/skips/:date` (same shape and `YYYY-MM-DD` guard as the other strategies) and flipped `hasDayLog` to true. The new two-segment routes do not shadow the existing `/download/trades.jsonl`, `/download/daily-files` or `/download/skips-all`.

### Fixed — GAPS day-log and per-day viewer links were blocked by the API-secret gate

Follow-on to the entry above: the endpoints existed but were unreachable from the UI. `OPEN_PREFIXES` in [app.js](src/app.js) exempts each strategy's `/{mode}-paper/view/` and `/download/` GET reads from the `API_SECRET` check, because `/realtime` and the History page link to them as plain anchors carrying no `x-api-secret` header and no `?secret=` query. All six existing strategies were listed; GAPS was not, so every GAPS day-log, trade viewer and skip viewer link returned `403 Forbidden` where the identical ORB link reached its route. Added the two GAPS prefixes. Verified by boot: the four GAPS read endpoints now return 404 for a date with no file — the same "route reached, nothing to serve" answer ORB gives — while `POST /gaps-paper/start` and `/reset` still return 403 without the secret, so no write path was opened.

**Validation**: 47 assertions over the engine and backtest exits (indicator alignment, both setups, both rejection paths, forming-bar isolation, configurable bands/source/length, warmup refusal, stop-before-target, EOD, target-disabled, no-gap skip) all pass; every touched file syntax-checks; the app boots and every GAPS page and JSON feed renders, every sidebar link resolves, and the export endpoints reach their handler (404 for a date with no file, matching the other strategies). Config is confirmed live end-to-end rather than assumed: booting with EMA 21 / RSI 14 / bands 90-10 and again with EMA 9 / RSI 7 / bands 80-20 moved the strategy config **and** the chart feed together, so the chart cannot disagree with the trade. **Not yet market-validated** — no paper session has run. Collect clean paper days and a `/replay` comparison before touching the live gates.


### Changed — ORB implementation audit: settings, parity, UI and dead code

A full pass over ORB against the standard the other five strategies already meet. **No trading behaviour changed** — no threshold, gate, ordering or fill rule was touched; `runOrbBacktest` produces identical trades before and after.

**Settings**
- Added `ORB_BT_SLIPPAGE_PTS` and `ORB_BT_SEED_PREMIUM` to the Settings UI. Both were code-only despite the identical `TREND_PB_BT_*` pair being exposed, so the ORB backtest's two honesty knobs could only be changed by hand-editing `.env`.
- Regrouped the ORB Settings section into the house order used by Trend Pullback (live gates → entry → exits → option selection → risk/regime → backtest → debug). It previously interleaved the debug toggle, the ITM-strike knob and the spread cap among the exit and day-filter fields.
- Flagged the **47 retired `ORB_*` keys** a deployed `.env` still carries from the pre-rebuild V1/V2/V3 engine (RSI, ADX, EMA20/50, wick, volume, sweet-spot, prior-day levels, the old %-based stop/target/trail…). They are read by no code, but `tickRecorder.snapshotSettings()` matches `/^ORB_/`, so every replay recording and daily-JSONL settings block advertises filters that do not exist — and several read as if they configure a live rule (`ORB_TRAIL_ENABLED` does **not** gate the EMA trail; `ORB_ATR_PERIOD` and `ORB_BUFFER_*_MULT` are hard-coded constants in `orb_breakout.js`; `ORB_TARGET_RANGE_MULT` became the exported `TARGET_OR_MULT`). [app.js](src/app.js) now warns at boot with an exact-key list, alongside the existing `SWING_`/`SCALP_` prefix warning — a prefix rule cannot catch these, since the live keys share the `ORB_` prefix. README carries a one-key-per-line bulk-delete block. The `.env` files themselves are the operator's to clear (local **and** EC2); deleting all 47 changes no behaviour.

**Parity**
- `ORB_VIX_STRONG_ONLY` is honoured by `vixFilter` for mode `orb`, but the ORB Paper and ORB Live status bars hard-coded `strongOnly: Infinity` — so the VIX chip read "NORMAL" right up to the block threshold and never showed the amber STRONG-ONLY band the setting configures. Both now read `vixFilter.getVixStrongOnly("orb")`.
- ORB **Live** trade records dropped `oiAtEntry` / `oiRegime` (the position object had captured them all along) and `isFutures`, all of which ORB Paper writes — so live and paper rows could not be compared field-for-field in the JSONL. Added; observer-only.
- `/orb-backtest`'s "gates active in paper/live but not modelled here" disclosure was wrong twice: it printed the premium band with a **₹80** default the engine never uses (the real default is ₹120), and it tested `ORB_MAX_SPREAD_PTS || "0"`, declaring the spread gate inactive whenever the ORB-specific key was simply unset — exactly the case where paper/live fall back to `MAX_BID_ASK_SPREAD_PTS` and the gate **is** active. Both now mirror the routes' own read order.
- `ORB_DEBUG_TRACE` printed the per-candle funnel from bar-based harnesses too, so leaving the toggle on turned one multi-year `/orb-backtest` run into millions of lines through the `/logs` SSE ring. `getSignal`'s tracer now respects `opts.silent` (backtest + `orbValidate`); `sig.gates` is still populated everywhere, so nothing is lost.
- `scripts/orbValidate.js` recomputed its reported `atr5` with a raw `ATR.calculate()`, re-introducing the overnight-gap contamination `_atrAtLast()` fixes — so the regime buckets it prints were sliced on a yardstick the engine no longer uses. It now reports `sig.atr5`.

**UI**
- ORB was the only strategy on `/realtime` stuck showing "— No Day Log —". It wrote both day files all along (`skipLogger`/`tradeLogger` mode `orb`) but never served them; added `/orb-paper/download/skips/:date` + `/download/trades/:date` (same shape as bb_rsi/PA/EMA_RSI_ST/EMA9+VWAP) and flipped `hasDayLog`.
- Added the sidebar **LIVE** badge for `/orb-live`. ORB has a native live route that sets `ORB_LIVE` in `sharedSocketState`, and bb_rsi and PA both badge theirs — an ORB live session placing real Fyers orders was the only one invisible in the nav.

**Dead code**
- Removed `renderIdleForm()` from [orbBacktest.js](src/routes/orbBacktest.js) (~60 lines, never called — `/idle` redirects) and the now-unused `buildSidebar` / `sidebarCSS` / `sharedSocketState` imports it was the only consumer of.
- Removed `POST /orb-paper/delete-session/:idx`. Unreachable — the shared history page calls `DELETE /session/:index` — and it adjusted `totalPnl` without recomputing `capital`, so anything that had called it would have desynced the History page's capital figure.
- Removed unused imports from [orbPaper.js](src/routes/orbPaper.js) (`tableEnhancerCSS`, `tableEnhancerJS`, `toastJS`, `parseOptionDetails`).
- Corrected the stale `ORB_SIG_WINDOW` comment (it claimed to seed "EMA20/EMA50/ADX/RSI" — all deleted in the rebuild; it seeds ATR(5m)/ATR(15m) and the EMA trail) and the `/orb-backtest` endpoint list in the file header.
- README: `ORB_LIVE_DRY_RUN`'s default was documented as `true` in the ORB table and `false` in the live-gates table — the code default is `false`. Also de-duplicated the `ORB_MAX_WEEKLY_LOSS` / `ORB_LOSS_STREAK_SKIP` rows.

### Fixed — ORB's ATR was measuring the overnight gap, not intraday volatility

Wilder's true range uses the **previous** bar's close, so on the first bar of a session `TR` collapsed to the close-to-open gap — a move nobody could trade. ORB freezes its volatility yardstick at 09:25, where a 14-period ATR spans ~2 bars of today and ~12 of yesterday, so that one contaminated bar carried roughly 1/14th of a full gap into every ATR-scaled threshold: the decisive-body gate (`0.6×ATR5`), the breakout buffer (`0.3×ATR5`), the ATR stop floor and the day filter (`OR ≤ 2.5×ATR15`).

The distortion was large, and worst exactly where it should have been smallest — after the biggest gaps. Provable case: on **2026-07-29** the engine reported a body threshold of `34.8pt = 0.6×ATR5`, i.e. **ATR(5m) = 58pt**, on a session whose entire 15-minute opening range was **51.6pt**. An average 5-minute true range cannot exceed the 15-minute range containing it. Across the 14 logged sessions from 10-Jul the body gate blocked **7** of them at thresholds implying ATR5 of 25–58pt.

`_atrAtLast()` ([orb_breakout.js](src/strategies/orb_breakout.js)) now excludes the cross-session true range. It does **not** hand-roll ATR (repo convention is `technicalindicators`): since `TR[i] = H[i]−L[i]` whenever `C[i−1]` lies inside `[L[i], H[i]]`, the previous close is clamped into the range of any bar that opens a new IST day. `C[i−1]` feeds only `TR[i]`, so nothing else shifts. `_to15m()` now carries a `time` so the 15-minute ATR can see the day boundary too — without it that series silently kept the gap. Verified on a synthetic series with a true 10pt 5-min range and one 120pt gap: **17.08 → 10.00**.

**Expect more ORB trades.** Every ATR-scaled threshold now reads lower and no longer spikes after a gap. That is the gate running at its intended strictness, not a loosening — but it does mean ORB's constants were chosen against a distorted ruler, so every ablation figure in the engine header predates the fix and needs re-deriving with `scripts/orbValidate.js`.

### Fixed — ORB backtest ran a dead EMA trail, and could trade a day paper never would

Two parity defects in [orbBacktest.js](src/routes/orbBacktest.js), both of which made it report trades the live engine could not have taken:

- **The EMA trend-trail was effectively disabled during most of the entry window.** The backtest computed its EMA over `dayCandles` — today's bars only — so a 20-period EMA returned `null` until the 20th bar of the session (index 19 = the 10:50 bar, first usable at its 10:55 close). Paper computes the same trail over `state.candles`, a ~7-day preload, so its EMA20 is live from the first candle. Same rule, different data, different exits. It now uses the multi-day slice `getSignal` already receives.
- **Day 1 of any range had no prior-day history**, leaving ATR unseeded and the ATR-dependent gates failing *open*. Paper always carries its preload and never runs in that state, so the first day is now skipped rather than reported.

### Fixed — ORB recorded `wickPass: true` for a filter that does not exist

The wick filter was deleted in the 2026-07-26 rebuild, but `getSignal` still hard-coded `sig.wickPass = true`, so every trade record and every AI export has carried a passing verdict from a gate that never ran. Left `null` now — no filter, no verdict. (`vwapAligned` is unchanged: that gate is real and genuinely passed.)

### Hardened (not a bug) — ORB's volatility-yardstick fallback

If `getSignal` ever reached the "today has no pre-09:30 bar" branch it fell back to the **whole** candle array, including today's post-OR bars — which would let the breakout candle help set the threshold judging it. It now degrades to prior days only.

**This branch is currently unreachable and the change fixes nothing observable.** A valid opening range requires a candle with `09:15 ≤ m < 09:30`, which is also a candle with `m < orEnd`, so a non-null OR already guarantees the index is found; brute-forced over 3,000 random sessions (794 with a valid OR, 0 hits). It is defence-in-depth in case the OR window and the freeze point are ever allowed to diverge — listed here so it is not mistaken for a fix.

### Changed — ORB exit rules have ONE owner (`src/strategies/orbExits.js`)

ORB's entry has had a single owner since the 2026-07-26 rebuild; its **exits** were hand-maintained in four places — `orbPaper` (canonical), `orbLive`, `orbBacktest` and `scripts/orbValidate.js`. That is how this repo once shipped a backtest that evaluated the close-based rules *before* the intrabar ones and "silently reported a different trade from the one the live engine would have taken".

All four now call [orbExits.js](src/strategies/orbExits.js) — opposite-candle, breakeven, EMA trail, rupee cap, premium stop, hard SL and MFE/MAE tracking. Routes keep only *execution* (simulate a fill / place a broker order / back-solve a bar fill). Replay was never affected: it re-runs paper's own `onTick()`.

**No behaviour change** — this is a faithful extraction of paper's rules, which stay canonical. Verified by fuzzing the extracted module against the shipped pre-refactor logic over **120,000 randomised cases** (side, prices, candle shapes, and randomised `ORB_MAX_TRADE_LOSS` / `ORB_PREMIUM_STOP_PCT` / `ORB_OPP_CANDLE_*` / `ORB_BREAKEVEN_*` / `ORB_TRAIL_EMA`): **0 mismatches** in exit reason, breakeven arming, stop level, EMA arming and `lastEma`.

### Added — ORB now warns when the option premium goes stale

ORB tracked `optionLtpUpdatedAt` and never read it, so a dead option poll fed the rupee cap, the premium stop and the exit P&L an arbitrarily old price with nothing in the log. It now logs once per trade, matching every other engine. **Warn only — the exit rules are unchanged** (see `emaRsiStPaper`); gating exits on staleness would be a behaviour change, not a bug fix.

### Changed — `ORB_MAX_DAILY_LOSS` is now documented as inert at the default

At `Max Trades/Day = 1` the trade budget is spent before the daily-loss gate can be tested, so the setting cannot change any outcome; at the ₹3,000 default one trade's ₹1,500 cap can never reach it either. The Settings description now says so and points at *Max Loss per Trade* for real per-trade risk. No behaviour change.

### Fixed — saving the common Option Expiry now actually reaches every strategy

A per-strategy expiry key always beats the common one inside `validateAndGetOptionSymbol` (`modeOverride || commonOverride`), so changing the expiry on the **Dashboard** strip or in **Settings** left any strategy carrying its own override trading the *old* contract — while both screens reported a successful save. The Dashboard's `⚠ EMA_RSI_ST ignores this →` note was the only hint, and it appeared even for `BB_RSI_`/`PA_` keys that nothing reads.

Saving `OPTION_EXPIRY_OVERRIDE` / `OPTION_EXPIRY_TYPE` now mirrors that date **and** type into `EMA_RSI_ST_`, `ORB_`, `EMA9VWAP_` and `TREND_PB_OPTION_EXPIRY_*` — one fan-out inside `POST /settings/save` ([settings.js](src/routes/settings.js)), so the Dashboard quick-edit, the Settings page and bulk-paste all behave identically. Details:

- **Honoured list is single-sourced** as `EXPIRY_MODE_PREFIXES` in [instrument.js](src/config/instrument.js) — the four engines that pass a `mode`. `BB_RSI`/`PA` pass none, so their per-mode keys are inert and are deliberately never written (and no longer trigger the Dashboard warning or the stale-expiry banner).
- **Per-strategy saves stay independent.** Editing only `EMA_RSI_ST_OPTION_EXPIRY_*` sends no common key, so nothing fans out. A per-mode key sent in the *same* request wins — that is what keeps **Save All** writing exactly what the page shows.
- **Date + type move as a pair**, so a strategy can never end up on the new date under the old type. Clearing the common date clears the copies, so "back to auto-detect" reaches everyone — and a bulk-paste `-OPTION_EXPIRY_OVERRIDE` **delete** cascades to the copies for the same reason (they would otherwise outlive the key they were mirrored from and keep every strategy pinned).
- **Auto-filled section defaults do not trigger it** — saving an unrelated key in *Common — Instrument & Backtest* can auto-fill `OPTION_EXPIRY_TYPE`, which must not re-stamp every strategy's expiry.
- The Dashboard warning now reads `⚠ … differs →` and fires only on a genuine mismatch; the stale-expiry banner groups keys by date instead of repeating the same date five times.
- `EMA9VWAP_OPTION_EXPIRY_OVERRIDE` / `_TYPE` are re-labelled **instant** (they were marked session-restart, but both are read from `process.env` at entry time) — otherwise every common expiry save would have raised a false "restart needed" prompt.

### Added — date-range filter in the Dashboard top row

The Dashboard top bar now carries a **Range** selector next to the PAPER/LIVE toggle. It narrows the cumulative P&L chart and every per-strategy chart — including their trade counts, W/L and net — and composes with the PAPER/LIVE toggle. Purely a client-side filter over the trades already loaded, so changing the range refetches nothing.

The option set is now **This month / Last month / Current week expiry / All / Custom** — the Dashboard opens on *This month*, Edge Analytics on *All* — and **Edge Analytics** was changed to match — it previously offered *Last 7 days / Last 30 days / This FY*, which are gone. Both pages read one definition (`dateRangeOptionsHTML()` + `dateRangeJS()` in [sharedNav.js](src/utils/sharedNav.js)), so they can't drift on what a range means. *Current week expiry* covers the day after the previous NIFTY weekly expiry through the current one; it reads `/api/expiry-dates` (lazily, on first use) so a holiday-preponed expiry is honoured, and falls back to the Tuesday→Tuesday week if that call fails. `/consolidation-report` keeps its own longer preset list.

### Fixed — a cancelled 0DTE warning no longer silently skips the rest of Start All

Two engines carry the expiry-day gate (EMA_RSI_ST and EMA9+VWAP), so on an expiry day **Start All (Paper)** raises the same-looking warning twice. Cancelling (or clicking outside) the second one aborted the remaining strategies and just reloaded the dashboard with **no message at all** — the skipped engine looked started and sat stopped for the whole session. Three changes:

- The warning's title now names the strategy (`EMA9+VWAP · 0DTE Expiry Day — Not Recommended`) so the second prompt can't read as a duplicate of the first.
- Cancelling now shows exactly which strategies did **not** start, plus how many already did.
- The warning body no longer claims "nothing starts" — strategies started before the cancel keep running, which is what actually happens.

### Changed — EMA9+VWAP option-expiry override is easier to find in Settings

Renamed to **"EMA9+VWAP Option Expiry (override)"** (a date picker now, matching EMA_RSI_ST's) and the help text spells out the fallback: blank means it inherits the common Option Expiry, so when that common date is today, EMA9+VWAP is on 0DTE and `/start` blocks.

### Removed — whole-day replay of days a strategy never ran (both the "Day replay" card and the Date-range fill-in)

Replaying a recorded day for a strategy with **no session marker** on it produced a P&L that looked real and wasn't. An EMA9+VWAP PE replayed on **2026-07-28** (paper never started that day) reported **−₹1829** for a 26.6-point adverse spot move. That is `26.6 × 65 qty + ₹100` — the `spot proxy (option LTP unavailable)` branch in [ema9vwapPaper.js](src/routes/ema9vwapPaper.js#L965) plus the flat charge estimate [getCharges](src/utils/charges.js#L99) returns when there is no premium data. A real ATM PE at ~0.5 delta would have lost roughly half. Nothing in the UI distinguished that number from a genuine one.

Root cause of the missing premiums is **unresolved**. The replay stub returned `no_data` for that strategy's option symbol, meaning `options.jsonl` held no ticks under that exact symbol string — even though the day-wide [optionChainRecorder](src/utils/optionChainRecorder.js) (ATM±5 every 5s, default on, shipped 2026-07-25) exists precisely so any strike is replayable regardless of who ran. A symbol/expiry-string mismatch between what the recorder wrote and what the strategy asked for is the leading suspect, but it has not been confirmed against the recording.

Until it is, both entry points are gone: `POST /replay/run` no longer accepts `synthesize`, and the Date-range card no longer fills in marker-less days. The `synthesize` path inside [tickReplay.js](src/services/tickReplay.js) is left intact but unreachable, so this is a one-line revival once the missing-symbol cause is understood and verified.

- The From/To calendars again offer only days with a session marker; marker-less recorded days are not selectable.
- Kept from the reverted work: `POST /replay/run` still validates `date` shape on every request (path-traversal guard), and Delete-all still re-fetches the session list rather than clearing it locally.

### Fixed — the day is now recorded as a market archive, not as a by-product of running strategies

Replay recording was strategy-dependent in one place that mattered: nothing ever opened the Fyers spot feed except a strategy's own `/start`, and the last strategy to stop tore it down again. So a day where you started **no** strategy recorded **nothing**, and stopping the last strategy at 14:00 ended that day's recording at 14:00 — leaving a partial archive that a strategy added later can never replay.

A supervisor ([src/utils/spotFeedSupervisor.js](src/utils/spotFeedSupervisor.js), `SPOT_FEED_ALWAYS_ON=true` by default) now keeps the shared feed connected 09:15–15:30 IST regardless of what is running, and re-connects within ~10s if a strategy's `/stop` closes it mid-session. It opens no second socket (it asks the same `socketManager` singleton, so the fan-out invariant holds), registers no tick callback (`recordSpotTick` already runs inside the socket's message handler), places no order, and never stops a feed a strategy is still using. It stands down for: `SPOT_FEED_ALWAYS_ON=false`, an in-flight replay, a missing Fyers token, a dead token (`isAuthFailed`), and weekends/NSE holidays.

Two smaller archive-integrity fixes alongside it:

- `FYERS_INV_AMOUNT` / `ZERODHA_INV_AMOUNT` are now captured in the session settings snapshot. They set each strategy's paper capital base, so a SNAPSHOT replay of an old day was reading **today's** investment amount — editing it silently changed a past day's replayed capital and return figures. New recordings pin it; old ones keep the current-env behaviour (there's nothing to pin).
- `tickRecorder.recordMarketContext` is now stubbed for the duration of a replay, like every other recorder write. It is only reachable from the live socket handler today, but `Date.now()` inside a replay is the *replayed* date — so any future caller could have minted a `market.jsonl` for an old day out of today's option chain. The archive is read-only during a replay, with no exceptions.

### Fixed — replay engine audit: stale cache results, a recording gap, and a path-traversal write

Full re-audit of the recorder + replay engine. Five real defects:

- **"My current settings" could silently re-serve a stale result.** The cache key was built from the key set captured *when the day was recorded*, read at today's values — so a tunable that did not exist back then could not move the key. Change it, re-run, and the cached result came back unchanged, making the setting look like it did nothing. The key now covers the union of the recorded keys and every managed key set today, sorted for a stable hash, and fingerprints `oi.jsonl` + `market.jsonl` as well. Cache version bumped to 9, which drops entries computed under the leaky key.
- **A replay during market hours punched a permanent hole in that day's recording.** Now that the feed stays up with no strategy running, a replay started at 11:00 would stub `recordSpotTick` and pause the chain recorder for its whole duration — dropping real ticks from an archive that can never be re-made. `replayPreflight()` now refuses while the day is being recorded, and says to replay after 15:30 or turn the feed off.
- **Path traversal in the day-folder lookup.** `POST /replay/run` and `deleteSessionMarker()` joined an unvalidated `date` straight onto the archive root — and the latter *rewrites* the `sessions.jsonl` it resolves, so a crafted date could clobber a file outside the archive. Validation now lives at the join site (`_dayDir`), so a new endpoint can't reintroduce it by forgetting to check.
- **Day replays wrote a settings-blind cache entry.** A synthetic day session has no settings snapshot, so its key can't tell two configurations apart. `/replay/run-day` passes `noCache` and never reads one, but writing it left a trap for any future caller that didn't.
- **A failed replay reported a nonsense duration** (e.g. "-38 days"): the error path measured elapsed time with `Date.now()` while the harness still had it pinned to the replayed instant. The cache pruner had the same latent exposure — with a replay-era clock it would have deleted every cached entry on one write.

Also corrected the docs: the tick archive lives at `<repo>/data/ticks`, not `~/trading-data/ticks` as README and CLAUDE.md both claimed. On EC2 it survives deploys only because the deploy rsync runs without `--delete` — now written down, because adding one would erase every recorded day.

### Fixed — every screen in the app now works on a phone

Swept all 65 screens (44 app pages, the 7 standalone strategy guides, the Settings gate + audit log, the broker login pages and the 404) at 320 / 360 / 393 / 430 / 768px, in both themes, measured over CDP at real mobile viewports. Four classes of problem, and the fix for each is shared rather than per-page wherever the cause was shared.

- **Three pages laid themselves out wider than the phone and were zoomed out to fit.** The Settings App-Secret gate had **no viewport meta at all**, so the browser used its 980px desktop fallback and shrank the page to ~40% — legible only by pinch-zooming. `/docs` came out at 640px and `/result` at 440px. Eleven HTML documents in total were missing the tag (both broker login/error pages, four backtest and paper error pages, the Settings audit log, the printable contract note and the generic HTTP error page); all of them have it now.
- **Tapping any filter field zoomed the whole page on iOS.** Every filter bar in the app rendered its inputs between 10.6px and 13.6px, and iOS Safari zooms the page whenever a field under **16px** takes focus — with no way to undo it. All form controls are now a literal `16px` below 768px (px, not rem: a rem value tracks the root size and can fall back under the threshold).
- **Controls were too small to hit.** 44px is the minimum a fingertip lands on reliably; the app's controls measured 14–35px. The hamburger — the only route to the menu on a phone — was 36×30, and the drawer's own links were 35px. Buttons, inputs, selects, the tab strips, breadcrumbs, the backup banner's link and ✕, and the header links that carry no class of their own (📊 History, ← Status, 🤖 AI export) are all ≥44px now.
- **Some controls could not be reached at all.** `.main-content` clips rather than scrolls below 768px, so anything pushed past the edge was painted nowhere. On `/trade-logs` that hid three of the five tabs; its download toolbar is `justify-content:flex-end` with no wrap, so the From/To date pickers overflowed off the **left** edge to x=-171. On Settings at 320px the per-section Load Defaults and 👁 buttons went the same way, and `SAVE ALL → .env` sat 710px inside a scroller whose scrollbar is deliberately hidden — nothing on screen suggested it was there.

Also: rendered markdown wraps unbroken env keys (`EMA_RSI_ST_OPPOSITE_SIDE_COOLDOWN_CANDLES` alone was dragging `/docs` out to 640px) while fenced blocks keep their formatting and scroll; the guides' setting tables scroll in their own box instead of stretching the document; and their two-column contents lists collapse to one.

The shared alert banners are `position:fixed; top:0`, so whichever one is up sat on top of the sticky top bar and the hamburger — the known issue from the previous entry, and bigger tap targets would have made it worse. The visible banner's height is now published as `--banner-h` on `<html>` and the mobile stylesheet offsets the body, top bar, hamburger and drawer by it; the banner also drops its parenthetical hint on a phone (103px → 82px). Desktop still reads none of this, so its behaviour is unchanged.

Verified: 0 pages overflow, 0 unreachable controls, 0 sub-16px fields and 0 sub-40px targets at all five widths in both themes. Desktop was re-measured against the pre-change build at 1440px across all 64 pages — every computed box is identical; the only three deltas are `flex-wrap:wrap` on `/result`'s nav (which changes nothing until the window is under ~960px, where the links used to run off the edge) and one new class name.

### Fixed — broker rows wrapped to two lines, and the expiry fields collided on iOS

Three things, all found on a real device rather than in the headless harness:

- **The date field ran into the type select on iPhone.** iOS gives `input[type=date]` an intrinsic minimum width from its rendered text ("Jul 28, 2026") and will not shrink below it however the flex item is sized, so side by side the date box grew straight into the select. Headless Chrome renders a narrower date control and never reproduced it. Below 640px the two fields and Save now take one full-width row each — verified collision-free even with the date control forced to a 260px minimum.
- **`Market Data · WS · REST` / `Orders · Live Trade` removed.** Measured at 1250px, that text alone pushed the Zerodha login button onto a second line; without it the row fits. All four now-dead `.brk-role` rules went with it.
- **The three-track broker grid started too early.** A broker row needs ~470px to keep its login button inline, and the 1500px threshold gave each one only 439px at a 1550px window — so it wrapped anyway. Raised to 1700px (1700 − 200px sidebar − 40px padding = 1460 content, ÷2.95fr ≈ 489 per broker). Both rows are now single-line at 1250 / 1550 / 1650 / 1750 / 1920px.

Also raised the stale-expiry banner's "Change Expiry" button to a 44px tap target — it measured 31px, and it is the primary action of an alert that blocks entries.

### Fixed — the expiry quick-edit was too small to use on a phone

Measured at a 393px viewport, the date field, the weekly/monthly select and Save all came out **26px tall with an 11.2px font**. Two problems: 26px is well under the 44px tap target, and iOS Safari zooms the entire page when you focus an input whose font-size is below 16px — so tapping the date field would have yanked the layout around. Below 768px the inputs now use a literal `16px` (that is the exact iOS threshold, so it is not expressed in rem) and every control has `min-height:44px`, including the per-mode warning link, which was a 21px-tall line of text despite being a link to Settings. Desktop is untouched — still 26px/11.2px at 1440px.

### Fixed — the Dashboard top bar was unusable on a phone

`.top-bar`/`.top-bar-right` carried `flex-wrap:nowrap !important` + `flex-shrink:0` with **no media query**, so they overrode both sharedNav's wrapping `.top-bar-right` and its `@media(max-width:768px)` wrap rule. Measured over CDP at a real 393px viewport (headless Chrome cannot go below 500px with `--window-size`, which is why this survived earlier screenshot checks — those renders were 500px cropped to look narrower): the bar was pinned at its **920px** content width and overflowed by 815px, putting Start All (Paper), Start All (Harness), Reset Token, the expiry/holiday pills and the status badge off screen behind `.main-content`'s `overflow-x:clip`. They were not merely cramped, they were unreachable.

Those rules are now scoped to `min-width:769px`, with a phone counterpart that lets each group wrap onto its own line (`min-width:0` is the part that actually permits shrinking — a flex item's automatic minimum size holds it at content width otherwise) and lets the nowrap expiry/holiday pills wrap so they clear 320px too. Verified 0 elements wider than the viewport at 320/360/393/430/768px, and byte-identical computed styles at 1440px.

Known and unchanged: the shared backup-nag banner is `position:fixed; top:0`, so it overlays the first ~58px of every page including the top bar's first row. Pre-existing and not specific to mobile.

### Fixed — the expiry pill and its popup on a phone

`📅 Next Expiry Date : 28/07/2026 - M - 1 day` is 41 characters and 283px wide, so on a 393px iPhone it claimed a top-bar row of its own. Each schedule pill now carries a long and a short label and picks by viewport (`📅 28/07 · M · 1d`, 122px), re-picking on resize/rotate — the top bar measures **176px → 146px** at 393px, one row less before the broker cards start.

The popup itself was cramped at that width: the 40px/20px backdrop padding left a 353px card, which wrapped `28 Jul 2026` onto two lines. That padding moved out of the inline style into `.eh-modal` so a ≤640px rule can drop it to 14px/6px (card 353px → 381px), with tighter cell padding and non-wrapping dates. The body already scrolls sideways, so a row that still doesn't fit scrolls rather than being cut. Measured over CDP at a real 393×852 viewport — `--window-size` clamps at 500px and never showed the wrap.

Desktop is untouched: `getComputedStyle` for the backdrop, card, both tabs, th, td, monthly row, preponed cell, legend, dot, body and table is identical to the pre-extraction commit on both themes.

### Added — the Dashboard expiry pill opens the expiry / holiday calendar

The `📅 Next Expiry Date : 28/07/2026 - M - 1 day` pill in the Dashboard top bar was a read-only label, and the full NIFTY expiry calendar + NSE holiday list existed only behind the Settings page's `📅 EXPIRY & HOLIDAYS` button. Clicking either Dashboard pill now opens that same popup (Expiry Calendar / NSE Holidays tabs, REFRESH button).

The popup's CSS, markup and JS moved out of [settings.js](src/routes/settings.js) into `expiryHolidayModalCSS()` / `expiryHolidayModalHTML()` / `expiryHolidayModalJS()` in [sharedNav.js](src/utils/sharedNav.js), so both pages render one copy rather than two that can drift. Colours are literals there instead of `var(--…)` because the Dashboard has no `:root` variable block.

That swap cost the light theme at first: the global rewriter only restyles `.holiday-table` **th** (and borders), so with `UI_THEME=light` every cell kept the dark `#c8d8f0` and the calendar read as pale blue on white. Verified in headless Chrome, then fixed — the cell text, today-row, legend and scrollbar now have explicit light-theme rules alongside the tab buttons. The pill's hover also darkens instead of brightening in light mode, where brightening a near-white pill showed nothing.

The two pills also moved out of the idle-only block in the top bar — they used to disappear while any session was running, which is when the next expiry matters most.

### Added — option expiry can now be changed from the Dashboard

`OPTION_EXPIRY_OVERRIDE` and `OPTION_EXPIRY_TYPE` were only editable on the Settings page, so fixing a stale expiry meant leaving the Dashboard. Both now appear as a compact strip in the broker row — a date field, a weekly/monthly select and a Save button. Settings keeps its own copy; this is a second editor for the same two keys, not a second source: Save posts to the same `POST /settings/save`, so the audit log and the per-mode daily settings snapshot record the change exactly as a Settings save does. Both keys are INSTANT-effect, so no restart is needed; the page reloads after saving so the expiry pill and the stale-expiry banner refresh.

The strip takes the dead horizontal space the two broker rows were leaving rather than costing a new line: three grid tracks above 1500px (Fyers | Zerodha | Expiry), the strip dropping to its own full-width row below that, and the fields stacking on phones. It hides with the broker rows while a trade is running, like every other control in that block: changing the expiry mid-session would change the contract the engine resolves for its next entry, which is what hiding these controls exists to prevent. Settings is still reachable if it genuinely has to change during a session.

`POST /settings/save` answers `success:true` as soon as `process.env` is updated, even when the `.env` write itself failed — the response carries that in `fileSaved`/`fileError`, and the section auto-fill can also pull in a key that needs a restart (`needsRestart`). The Settings page surfaces both; the strip was ignoring them and showing a green tick, so an unwritable `.env` (verified by injection: `EACCES` → `success:true, fileSaved:false`) would have looked like a clean save and then reverted on the next PM2 restart. The strip now mirrors the Settings page's three outcomes, and shows `⚠ Not saved` rather than a tick when the write failed.

A per-mode key **shadows** the common one — `validateAndGetOptionSymbol` reads `modeOverride || commonOverride` — so with `EMA_RSI_ST_OPTION_EXPIRY_OVERRIDE=2026-07-28` set, editing the common date on the Dashboard would have reported success while EMA_RSI_ST kept trading 28 Jul. The strip now names every shadowing mode inline (`⚠ EMA_RSI_ST ignores this →`, linking to that key in Settings) and the label no longer claims the field "applies to all modes". The mode list is shared with the stale-expiry banner so a 7th strategy only has to be added once.

### Fixed — `/settings/env` had been opened, and it returns the raw `.env`

Two commits ago the allowlist was extended to cover every plain-`fetch` call the pages make, and `/settings/env` was in that list. It returns the **whole `.env` file unmasked** — `API_SECRET`, `LOGIN_SECRET`, `ZERODHA_API_SECRET`, `ACCESS_TOKEN`, `TELEGRAM_BOT_TOKEN` — so opening it meant anything past the login cookie could read every credential. (`/settings/data` is the masked view; the "View .env" modal only masks for *display*, after receiving the real values.) Removed from `OPEN_PATHS` and its one caller switched to `secretFetch`. Verified: the endpoint answers 403 again and the response no longer contains the secret.

Also dropped the `/logout` entry added in the same pass: `GET /logout`, like `GET`/`POST /login`, is registered *above* the `API_SECRET` middleware and so never reaches it — the entry was dead config. Confirmed by probe (`/logout` still answers 302 with no allowlist entry).

A sweep for the remaining ways a page can call the server — `<form action>`, `EventSource`, `XMLHttpRequest`, `sendBeacon`, `<iframe>`/`<img src>` — found nothing else blocked: the only form POSTs are `/auth/manual` and `/settings/audit` (both handled), and the log/cache iframes point at already-open pages.

### Fixed — the Start / Stop / Exit buttons on five strategy pages landed on a 403 page

The `secretFetch` sweep below covered buttons that call their route with `fetch`. Five pages don't: ORB Paper, ORB Live, Trend PB Paper, BB_RSI Paper and PA Paper start and stop by **navigating** (`location.href = '/orb-paper/start'`). A browser navigation cannot carry the `x-api-secret` header, so with a secret set those buttons left the page showing `{"success":false,"error":"Forbidden — missing or wrong secret."}` — the session never started. The dashboard's Start All was unaffected (it already used `secretFetch`), which is why this stayed hidden.

Added `secretGo(url, btn)` next to `secretFetch` in [sharedNav.js](src/utils/sharedNav.js): it sends the request with the secret, reloads on success, and restores the button if the user cancels the prompt. The 13 navigation buttons now call it. Verified on a running server — all five pages define `secretGo`, none still emit a `location.href` to a start/stop/exit route, and those routes still answer 403 to an unauthenticated request.

The same audit found read-only destinations that are reached by link and so had the identical problem: `/logout`, `/auth/login`, `/auth/manual` (a plain `<form method=POST>`, so it cannot send a header either), `/auth/zerodha/login`, `/settings/audit`, `/backup/download`, both `/trade-logs/…/download-everything` routes and `/trend-pb-paper/download/…`. All are now open — gating them made broker re-login, Logout and every "download" button unreachable from the UI while leaving nothing safer. `/settings/audit` keeps its own `?secret=` prompt, exactly as `/settings` does. One dead link fixed in passing: the EMA9+VWAP backtest page's "Go to Live Trade" pointed at `/ema9vwap-live/status`, which does not exist — the harness page is `/ema9vwap-live`.

### Fixed — 35 buttons silently did nothing while `API_SECRET` was set

Exit, Manual Entry, Reset, every harness Start/Stop, Replay's Run / Cancel / Delete, Backup Create / Delete / Restore, Clear Logs, the Monitor actions and the P&L baseline editor all called their protected route with a plain `fetch`, which sends no secret. The route answered 403, the handler read `.json()` off the error body and fell into its catch — the position stayed open, the session never started, and in the fire-and-forget cases (`Exit`) the page reloaded as if it had worked. All 35 call sites across 16 files now use `secretFetch`, which attaches the stored secret, prompts once per browser session on a 403 and retries. Each site handles `secretFetch`'s `null` (user cancelled the prompt) by restoring the button instead of throwing; the Exit buttons capture their real label first rather than resetting to a hard-coded "Exit".

Verified by rendering every affected page and parsing its emitted client JS — 18 pages, all script blocks parse, and `secretFetch` is defined on each one that now calls it.

This also closed a hole opened by the `OPEN_PREFIXES` change below: `docs.js` serves `GET /file/:name` **and** `DELETE /file/:name` from the same URL, so a method-blind prefix made guide deletion reachable without the secret. Prefix matches are now restricted to GET/HEAD (`OPEN_PATHS` stays method-agnostic — `deploy/webhook` and `tracker/fetch-and-start` are deliberately POSTable). Re-probed: `DELETE /docs/file/…` is 403 again while `GET` is 200.

### Removed — the Price Action "Compare" menu item pointed at nothing

`compare.js` implements `/compare/trading` and `/compare/bb_rsi` only. The sidebar's PA entry linked to `/compare/priceaction`, which has no route, so with `UI_SHOW_COMPARE=true` it was a dead item. Dropped; the EMA_RSI_ST and BB_RSI entries are unchanged.

### Fixed — most pages returned a raw 403 when `API_SECRET` was set

Logging in was not enough to browse the app. `API_SECRET` is a second gate in front of the login cookie, and `OPEN_PATHS` — the allowlist of read-only routes that bypass it — had not been extended as pages were added. Verified with a real logged-in session against the repo's own `.env`: `/docs`, `/realtime`, `/replay`, `/monitor`, `/edge-analytics`, `/all-backtest`, `/orb-paper/status`, `/orb-backtest` and every live-harness page answered `403 {"error":"Forbidden — missing or wrong secret."}` while `/settings`, `/logs` and `/pa-paper/status` worked. Sidebar links carry no secret, so there was no way to reach the blocked half from the UI.

The allowlist now covers the read-only routes the sidebar and top bar actually link to, plus the plain-`fetch` polls those pages depend on (`/monitor/data`, `/replay/list`, `/backup/status`, `/auth/socket-health`, `/api/session-active`, `/settings/env`, the per-strategy `status/chart-data`). A companion `OPEN_PREFIXES` list handles the read-only routes that take a path parameter — `/docs/file/…`, `/docs/pdf/…`, and each paper router's `view/` and `download/` day viewers — which an exact-match allowlist can never reach; `/auth/callback` moved from a hard-coded `startsWith` into it.

Nothing that acts was opened. Re-probed after the change: all 41 sidebar targets now answer 200 (or a redirect), and `/…/start`, `/stop`, `/exit`, `/reset`, `/replay/run`, `/monitor/action/*`, `/settings/save`, `/backup/create`, `/logs/clear` and `/pnl-history/baseline/*` all still answer 403. Two things this surfaced but did **not** change: the sidebar's `/compare/priceaction` link has no route behind it at all (`compare.js` defines only `/trading` and `/bb_rsi`), and several buttons call protected routes with a plain `fetch` instead of `secretFetch`, so they fail silently while a secret is set — both need their own fix.

### Fixed — Start All ignored the EMA_RSI_ST toggle and skipped two strategies on Live

The dashboard's three Start-All buttons each built their own endpoint list, and `EMA_RSI_ST` was hard-coded into all three: with `EMA_RSI_ST_MODE_ENABLED=false` the strategy was hidden from the sidebar, the tiles and the docs, but Start All still started it. Start All (Live) had the opposite gap — its list stopped at four strategies, so `EMA9+VWAP` and `TREND_PB` were never included even when enabled.

All three lists (plus the labels in the confirm dialogs, the harness tooltip and the button-state status poll) are now generated by mapping the existing `enabledStrategies()` in [sharedNav.js](src/utils/sharedNav.js) — the same helper the sidebar, Edge Analytics, the Consolidation Report and /docs use — over a `START_ALL_ROUTES` table holding each strategy's paper/live/harness route. There is no second copy of the toggle logic, so Start All and the sidebar cannot disagree: every enabled strategy starts and no disabled one does. `EMA9+VWAP` and `TREND_PB` have no separate pure-live engine — their `/…-live` route *is* the harness — so they take part in Paper and Harness and are correctly absent from Live; that is now expressed as `live: null` on their row rather than as a missing entry. Adding a strategy to Start All is one row in the roster.

Verified against a rendered dashboard rather than by reading: on the current config (`EMA_RSI_ST`, `ORB`, `EMA9VWAP` enabled) the page emits 3 paper, 2 live and 3 harness endpoints, and with every strategy disabled it emits none. That render also exposed a real gap — `/orb-paper/status/data` and `/orb-live/status/data` were never added to `OPEN_PATHS`, so with `API_SECRET` set they returned 403 to the button-state poll (a plain `fetch`, deliberately not `secretFetch`, since it runs on a 10-second timer and must not prompt). ORB was therefore invisible to the Paper↔Live mutual lock: a running ORB paper session did not lock the Live button. Both paths are now open, exactly as the equivalent paths already were for the other five strategies; ORB's `/start` routes stay protected.

The endpoint→display-name map used by the failure list and the 0DTE prompt was the last hard-coded strategy list in this path, and it was already slightly wrong: it derived the kind from the URL, so `EMA9+VWAP`'s harness route — which is spelled `/ema9vwap-live/start` — was labelled "Live" rather than "Live (Harness)". It is now emitted from the roster with the kind attached, so it cannot drift from the endpoints actually called.

Two consequences of the list becoming dynamic were handled: an empty roster (every strategy disabled) now shows "Nothing to start — enable one in Settings → Strategy Modes" instead of reporting success and reloading the page having started nothing; and the 0DTE expiry warning no longer assumes the strategy that raised it is `EMA_RSI_ST` — it names the actual strategy, and if you cancel it after others have already started, the page reloads to show them.

### Changed — /docs lists only the guides for enabled strategies

The Documents tab listed all seven guides regardless of configuration, so an install running three strategies still offered six strategy guides. It now follows the same rule as the sidebar, Edge Analytics and the Consolidation Report, via the existing `enabledStrategies()` in [sharedNav.js](src/utils/sharedNav.js) — one source of truth rather than a seventh hard-coded strategy list. On the current config (`BB_RSI`, `PA`, `TREND_PB` = `MODE_ENABLED=false`) the list drops from 7 files to 4, with a muted "3 guides hidden — strategy disabled in Settings" note so nothing appears to have simply vanished.

Two deliberate limits: a file **not** in the filename→strategy map is always listed, so a user upload or a guide added before the map is can never silently disappear; and `GET /docs/file/:filename` is **not** gated, so an existing bookmark or a "Sync to local" of a disabled strategy's guide still works. This is menu visibility, not access control. `enabledStrategies()` is read per request because Settings saves mutate `process.env` live.

### Fixed — the six "whole session" charts were one chart with six sets of overlays

Every strategy guide opened with a full-day candlestick chart, and all six were hand-written from the same template: the same ~24,1xx price base, the same 09:15–14:00 window, the same rally-then-fade shape, all exiting around 24,34x. Only the overlay lines differed, so side by side they read as the same picture — which is exactly how it looked with three guides open in three tabs. The hand-written overlays were also not derived from their own candles, so a line labelled "EMA20" was not the EMA20 of the bars beneath it.

All six are now generated, each from its own price path and its own price base, with **every** overlay computed from the candles it is drawn over — EMA from the closes, the VWAP ±σ band by the same equal-weighted HLC3 formula [ema9_vwap.js](src/strategies/ema9_vwap.js) uses, Bollinger from a real rolling standard deviation, and ORB's opening-range box measured off the first three bars rather than typed in. Each day also illustrates something different about its strategy:

- **EMA_RSI_ST** — a **bearish PE day** (24,6xx). Every other guide showed a CE; this one shows the mirror, with the EMA21 trail tightening downward from above.
- **BB_RSI** — a **40-minute scalp** (23,8xx) inside a quiet range, banked by the profit lock. Makes the point that BB_RSI is not a trend rider.
- **Price Action** — a **V-shaped double bottom** (24,4xx) with the neckline break deliberately *not* bought, and entry only on the retest.
- **ORB** — a narrow 36-point opening box (25,1xx) and one trade held four hours.
- **EMA9+VWAP** — two hours inside the channel doing nothing (22,9xx), one break, ended by the reversal rule rather than the signal exit — which is what actually happened on every winner in the first live sample.
- **Trend Pullback** — a **staircase** (26,2xx) with two pullbacks, where only the second produces a qualifying resumption candle.

Captions were rewritten to the new charts with their real times and prices, and one caption claim was corrected in the process: the passed-over first pullback was described as "before the entry window opens", but `TREND_PB_ENTRY_START` is 09:45 and the pullback is at 10:30 — it is skipped because no candle after it met the resumption test, which is the more useful lesson anyway.

The generator is deterministic (a seeded LCG, no `Math.random`), so regenerating produces byte-identical output and the guides do not churn in git.

**Follow-up from re-checking that change**: moving only the session charts left each guide internally inconsistent — the ORB session chart said 25,170 while ORB's own detail charts and its worked example still said 24,372 for what the text presents as the same example day. [tools/alignGuidePrices.js](tools/alignGuidePrices.js) shifted each guide's remaining charts *and* its quoted prices onto that guide's base. A constant offset, never a rescale: everything these guides teach is expressed in points (a 60-point box, a 38-point stop, +201 points) and adding a constant preserves every difference exactly — verified afterwards that the ORB box is still 60 points wide, the stop still 38, and `₹1,500` untouched. The price match is deliberately narrow (23,000–26,999, optional comma, optional decimals, with a lookbehind so it cannot fire inside a longer number) so rupee amounts, percentages, periods, dates and hex colours are not candidates.

**Second follow-up — three charts drew something their captions did not describe.** Checking the charts against each other only proves they differ; it says nothing about whether a marked exit obeys the rule the text claims. [tools/verifyGuideCharts.js](tools/verifyGuideCharts.js) now re-parses each session chart and tests that, and found three:

- **BB_RSI** — the caption said the profit lock fires on a 50% giveback, but the exit marker sat 6 points below the peak (~12%). Exit moved to the computed floor: entry 23,791, peak 23,841 (+50), floor 23,816, first touched 12:05. The caption now shows the arithmetic.
- **ORB** — the exit was marked at 14:05 with the close at 25,371 while EMA20 was 25,348, i.e. price was still *above* the trail; the chart showed a sale for a reason that had not happened. The first genuine close below EMA20 is 14:25, so the marker moved there and +201 became **+177**.
- **EMA_RSI_ST** — the caption claimed an EMA21 trail exit, but on a PE day the trail sits *above* price and this path never bounces that far — no candle after entry spans EMA21 at all. Rather than bend the price path, the caption now names what actually closes the trade: the **exit-before-close rule at 14:30** (`EMA_RSI_ST_EOD_EXIT_TIME`, the shipped Settings value). A better lesson anyway — not every trade ends on a signal, some just run out of day.

The verifier also asserts the ORB box is measured off its own first three candles, and that each caption's "+N points" equals exit − entry (reading the claim that *follows* the exit price, since a caption may legitimately quote an earlier figure too — BB_RSI quotes its +50 peak run before the +25 it banks). 13 assertions, all passing.

Final state, verified programmatically: **26 charts across 7 guides, all unique**, and the six strategy guides occupy six **non-overlapping** price bands — EMA9+VWAP 22,901–23,132 · BB_RSI 23,592–23,919 · Price Action 24,030–24,275 · EMA_RSI_ST 24,397–24,736 · ORB 25,048–25,425 · Trend Pullback 26,217–26,507. Two extra whole-file shifts were needed to clear the last overlaps (Price Action −300, BB_RSI −150); both are recorded in the tool.

### Docs — all seven guides and both strategy reference files re-synced to the code

A documentation pass over everything in [documents/](documents/) plus the root strategy references. No code behaviour changed; the only source edits are two stale **comments** and one README correction (see the end of this entry).

**ORB guide — the largest gap.** The guide still described the deleted V1/V2/V3 engines and their filters. Rewritten against the rebuilt single engine:

- The "0.7×ATR15 minimum opening range", the "must clear yesterday's high/low" fresh-ground rule and the "close in the extreme fifth" filter are **deleted**, not toggled off. The 9-gate checklist was rewritten to the funnel the code actually runs (time window → trade budget → OR ready → OR vs ATR15 → gap → breakout → candle quality → confirmation → retest window → option gates), each with the real numbers.
- The retest is now a built-in 6-candle fallback (`ORB_RETEST_MAX_WAIT`), not an optional `ORB_RETEST_ENABLED` experiment.
- **The stop section was materially wrong and is now honest**: the strategy asks for 50–83 spot pts, but `ORB_MAX_TRADE_LOSS=1500` on a 65-lot ~0.6-delta option binds at ~38 pts, so `orbStopRisk` clamps the placed stop and `ORB_SL_ATR_MULT` is **inert**. Documented with the arithmetic (₹1,500 ÷ (65 × 0.60) ≈ 38 pts) and the ~₹2,300 figure needed for the full ATR stop.
- New Section 10 "How much to trust the numbers" replaces the legacy-engines section: 9 trades / 39 sessions, PF 1.44, P(no edge) ≈ 37%, best trade = 211% of net (remove it → −₹3,786), the three superseded profit figures and why each was optimistic, the narrow-OR hypothesis, and why tuning `ORB_BODY_ATR_MULT` on this sample is selection bias.
- Config section rewritten to the keys the code reads, plus a **dead-keys table** (`ORB_ENTRY_V*`, `ORB_OR_ATR_MIN`, `ORB_PRIORDAY_LEVEL_FILTER`, `ORB_CLOSE_POS_PCT`, `ORB_RSI_*`, `ORB_ADX_*`, `ORB_ATR_PERIOD`, `ORB_BUFFER_*`, `ORB_RETEST_TOL_*`, `ORB_TARGET_RANGE_MULT`, `ORB_STOP_PCT`, `ORB_SL_CANDLES`, `ORB_PREMIUM_LOCKIN_*`) — these are not "off", they are simply not read.
- Also disclosed: the backtest cannot run the premium-band, spread or OI gates, so it always shows **more** trades than paper takes.

**EMA9+VWAP guide.** The VWAP caveat said the difference from TradingView was "a point or two"; it is a permanent design decision with measured numbers (up to 80.5 pts of band difference and 41/640 flag flips when volume weighting was still in play, 0.00 / 0 after). Added `EMA9VWAP_RESOLUTION`, the candle-timestamp entry window, the first-candle-of-session guard, the confirm-candle toggle that used to block every trade, the replay socket-mutex fix, `/simulate` isolation, and that the backtest now honours the optional stops it previously ignored. Replaced the "12 settings are `.env`-only" note — they are all in Settings now. Known-gaps section rewritten around the 23-trade verdict (one trade carries the sample; 16 Jul had the frozen-VWAP bug; 21 Jul was 0DTE).

**EMA_RSI_ST guide.** Added the spot-booked-as-premium defect (how to recognise the −₹15,35,170-shaped artefact in old records), the streak breaker that fired at a hardcoded 3 against a disabled key, and the stale-expiry block including the `pnlMode: "spot proxy"` symptom.

**BB_RSI, Price Action, Trend Pullback guides.** No rule changed in any of them; each gained the live-parity section (session-teardown race losing the final trade from the books, the `LIVE_EXIT_WAIT_MS` ceiling that cancels nothing, the portfolio cap that was missing from every live route) and the stale-expiry note. The PA guide now states plainly that PA is `MODE_ENABLED=false` on this deployment.

**Application Setup guide.** `npm test` / `test:orb` / `test:parity` / `test:config` documented (the guide still claimed there was no test step), plus four troubleshooting rows: the stale-expiry banner, `pnlMode: "spot proxy"` trades, the Loss Streak card's invented denominator, and why Stop now waits.

**Charts.** Six new inline-SVG charts through the TVChart kit: ORB gained a skipped-day (OR too wide), a retest-held entry and a rupee-cap loser; BB_RSI gained the ratcheting profit-lock exit; EMA_RSI_ST gained the EMA21 trail riding a winner; EMA9+VWAP gained reversal-exit-vs-signal-exit; Trend Pullback gained the three-rejected-then-trigger pullback. Every guide now carries a worked "real numbers" box beside each rule. A QA harness executes each guide's chart scripts in a `vm` sandbox and asserts every `tv-chart` div has a render call, every render call has a div, every chart produces SVG with no `NaN`/`undefined`, tags balance and no TOC anchor is dead — all seven guides pass.

**Root reference files.** [EMA_RSI_ST.md](EMA_RSI_ST.md) was rewritten: it still documented the **Parabolic SAR + EMA21-touch entry** removed on 2026-06-12, so its entry section, indicator list, exits, cooldowns and chart notes described a strategy that has not run for six weeks. Now the four-gate EMA-alignment / RSI-band / SuperTrend / close-beyond-EMA entry, with the code-vs-Settings default splits called out (`OPT_STOP_PCT` 0.15 vs 0.25, `MAX_DAILY_TRADES` 20 vs 5, `MAX_DAILY_LOSS` 5000 vs 3000, `EMA_RSI_ST_CANDLE_TRAIL_ENABLED` false vs true) and the note that the time-stop is inert at the shipped `SL_MODE=ema`. [BB_RSI.md](BB_RSI.md) gained §3a (the confirmation candle, default ON, which was undocumented) and the stale-expiry / live-parity sections.

**Source edits in this pass** (comments and one README table only, no behaviour): `computeVwapBands`'s docblock in [src/strategies/ema9_vwap.js](src/strategies/ema9_vwap.js) still claimed "volume-weighted when candles carry real volume", contradicting its own file header and the implementation; README's ORB table listed `ORB_PREMIUM_MIN` as `80` (code default is `120`) and `ORB_OI_ENABLED` as `true` in one table and `false` in another (code default is `false`); the indicator list still named Parabolic SAR, which is no longer computed anywhere in `src/`.

### Fixed — two ways the engines ignored their own configuration

A configuration-fidelity audit of the **enabled** strategies (EMA_RSI_ST, BB_RSI, ORB, EMA9VWAP, TREND_PB — PA and STRADDLE are `*_MODE_ENABLED=false`) asked one question of every value in `.env`: is this what the engine actually acts on? Two answers were no, and both failed silently.

**1. A stale option-expiry override was traded as if the contract still existed.** `OPTION_EXPIRY_OVERRIDE` was `2026-07-21`; the audit ran on the 26th. Because a per-mode override falls back to the common one, **all five enabled strategies** were pinned to an expiry five days dead. The manual-override branch of `validateAndGetOptionSymbol` was the only branch that returned its symbol **without** validating it via `getQuotes`, so the dead symbol reached the engines. ORB and TREND_PB blocked the entry; EMA_RSI_ST and BB_RSI **entered anyway**, logged `pnlMode: "spot proxy"`, and left `OPT_STOP_PCT` inert — it needs an entry premium that never arrived, so a configured 25% option stop simply did not exist for the life of the position.

- Staleness now has one definition, `instrument.isExpiryOverrideStale()` — past the expiry day's 15:30 IST close, so the contract still trades all through its own expiry day. The dashboard banner and the entry guard both call it and can no longer disagree.
- A stale override returns `{ invalid: true, symbol: null }` — the shape every caller already handles — plus the key name to fix. It deliberately does **not** fall through to auto-detection: quietly trading a different expiry changes premium, theta and therefore the risk of every position, which is the operator's decision, not the resolver's.
- The dashboard banner checked only the *common* key, i.e. not the one that actually binds. It now checks the common key **and** all six per-mode keys, and names each stale one.
- The `/manualEntry` routes in `emaRsiStPaper` / `ema9vwapPaper` were the last callers that never checked `invalid`; they would have entered on `symbol: null`. Both now refuse with HTTP 409.

**2. The consecutive-loss breaker fired at a hardcoded 3, ignoring its config key.** `EMA_RSI_ST_MAX_CONSEC_LOSSES=0` — which Settings labels "0 = OFF" — while a second, legacy streak rule paused entries regardless. Three ₹500 losers on 5-min blocked entries for 20 minutes on a strategy whose streak breaker was explicitly disabled, with the day's ₹1,500 still well inside `MAX_DAILY_LOSS=2000`. The Loss Streak card compounded it by rendering "2 / 3 ⚠️ 1 more = pause" against a breaker that was off. Both streak mechanisms now read the same key in `emaRsiStPaper`, `emaRsiStLive`, `ema9vwapPaper` and `backtestEngine`, so `0` means off and `N` means `N`; the card renders the configured limit or "breaker OFF", never an invented denominator.

New suite `tests/configFidelity.regression.js` (19 checks, `npm run test:config`, wired into `npm test`): the staleness boundary including the 15:30 edge and malformed input, per-mode-beats-common, that a *future* override still resolves (a guard that blocks everything is useless), that refusal never substitutes another expiry, and that no engine or card still carries a hardcoded 3. Its own first draft asserted against the developer's real `.env` — `instrument.js` calls `dotenv.config()` at require time, so env scrubbing must happen *after* the require; there is now an assertion that fails loudly if that regresses.

### Fixed — three defects in the new exit-wait helper, and it was undocumented

Recheck of the bounded-wait work below. The helper was new code and had not itself been reviewed.

- **The ceiling was read once at module load.** `LIVE_EXIT_WAIT_MS` was captured into a `const` when the file was first required, so changing it in Settings did nothing until a full server restart — while every other config read in this repo is live. Now read per call.
- **A typo silently removed the safety limit.** `LIVE_EXIT_WAIT_MS=abc` → `parseInt` → `NaN` → the `> 0` guard failed → the helper returned an *unbounded* wait. A fat-fingered setting disabling a safety ceiling is exactly the wrong direction; a malformed value now warns and falls back to 20000ms, and only an explicit `0` opts out.
- **Clever code in the reject path** — `reject((ceilingFired = true) && new Error(...))` worked only because the assignment evaluates truthy. Rewritten as two plain statements.
- **The key was in no README table and no Settings field**, violating the repo rule that README is the user-facing spec for env vars and that nothing ships without a Settings control. Both added (`EFFECT.INSTANT`, matching the now-live read), and the rendered Settings page was verified to contain the new field.

Four more assertions (malformed value falls back rather than disabling; the value is read live so Settings applies without a restart), both mutation-tested. `npm run test:parity` is now 25.

**Correction to an earlier claim in this changelog**: previous passes reported "`/settings/` renders 200, ok". That request was hitting the **API_SECRET auth gate** (48KB), not the settings page (469KB) — it proved nothing about the settings UI. The ORB paper/live status pages were genuinely ungated and those render checks stand.

Also noted, not changed (pre-existing, out of scope): `IMMEDIATE_KEYS` in [settings.js](src/routes/settings.js) is declared and never read.

### Fixed — bound the live square-off wait that the parity fix introduced

Recheck of the parity work below. Awaiting the broker exit was correct, but it created the opposite failure and I had not bounded it.

- **Neither broker SDK sets an HTTP timeout, and axios defaults to none.** A dead broker socket can hang until OS keepalive gives up — minutes. So `await squareOff(...)` inside `stopSession()` could hang the `/stop` request indefinitely, and stall `gracefulShutdown` on a deploy while PM2 waited to SIGKILL. New [src/utils/boundedExit.js](src/utils/boundedExit.js) caps the wait at `LIVE_EXIT_WAIT_MS` (default **20s**) for all four live routes. A healthy order round-trip is well under a second, so the ceiling never fires in normal operation and the books stay correct; it fires only in a real outage, where the operator gets a Telegram alert instead of a hung process.
- **The timeout cancels nothing** — a market order that has left the process cannot be recalled. It only stops us *waiting*, which is why the message reads "may still be in flight, verify the dashboard" rather than "exit failed".
- **A latent crash in the helper itself, caught by its own test**: when the ceiling won the race, the losing `exitPromise` kept running unobserved, so a slow-then-failing broker call surfaced as an unhandled rejection minutes later. A terminal handler is now attached, and it logs only when the ceiling actually fired (otherwise the caller is already receiving that rejection directly).

Six behavioural assertions added to the parity suite (fast exit undisturbed, hung exit bounded, message names the risk, a real broker error still propagates un-masked, a post-ceiling failure cannot crash the process, `0` opts out). `npm run test:parity` is now 23.

### Fixed — the two ORB paper↔live defects were systemic: same bugs in BB_RSI, PA and EMA_RSI_ST live

The ORB parity pass below found two root causes. Both turned out to be **defect classes, not ORB slips** — every other standalone `*Live.js` route had them too. The harness routes are unaffected (they execute their paper route directly).

**1. The session-teardown race — real money missing from the books.** `bbRsiLive.js` and `paLive.js` both fired `squareOff(...)` un-awaited from `stopSession()`, then continued synchronously to `saveBbRsiSession()` / `savePASession()` and `notifyDayReport()` while the sell was still at the broker. Stop a live session holding a position and the saved session is missing its final trade and its P&L — a ₹240→₹300 exit on qty 65 is **₹3,814 that never reaches the books**. Both are now `async` and await the exit before any bookkeeping, with `state.running` cleared first so no tick is processed during the round-trip.

`emaRsiStLive.js` has no session save inside `stopSession()`, so no P&L was lost there — but it called `squareOff` un-awaited inside a `try/catch` that **could not catch anything** (an async rejection is not a thrown error), and returned before the order went out. `gracefulShutdown` then proceeded toward `process.exit` with a real Zerodha position possibly still open — precisely the failure that function was added to prevent. Now awaited.

Manual `/exit` in `bbRsiLive` and `paLive` had the same shape with no `.catch()` at all: it answered `"Position exit triggered"` before placing the order, and a broker failure became an unhandled rejection. Both now await and return HTTP 500 on failure.

**2. The portfolio-wide daily loss cap was missing from every live route.** It was added to the six paper routes and none of the live ones, so with `PORTFOLIO_MAX_DAILY_LOSS` armed, paper stopped entering while live — the side with real money — kept trading. Now applied in `bbRsiLive`, `paLive` and `emaRsiStLive` (both its candle-close and intra-tick gate chains), at the same position in each sequence as its paper counterpart. All ten routes now check it. Block-only; it can never place or alter an order.

**New suite: [tests/liveParity.regression.js](tests/liveParity.regression.js)** (`npm run test:parity`) — 17 cross-strategy assertions covering all four live routes: live applies the portfolio cap, `stopSession` is async, it awaits the exit before any save or day report, every caller observes the promise, and live honours the same shared entry gates as paper. All mutation-tested — reverting any single fix fails it. `npm test` is now 28 + 36 + 17.

### Fixed — ORB paper ↔ live parity: eight verified implementation differences closed

Paper is canonical. `/orb-live-harness` runs `orbPaper.js` directly so it was never implicated; every defect below was in the standalone `/orb-live` route, a hand-written mirror that had drifted. **No strategy logic changed** — entry rules, exit rules, stop philosophy, sizing, strike/expiry selection and trading windows are untouched, and the backtest still produces the identical 9 trades / ₹3,878.

**Root cause 1 — live's exit performs I/O and paper's does not.** `simulateSell` is fully synchronous, so paper's `stopSession` always saw the final trade before its bookkeeping ran. `stopSession` in live fired `placeLiveSell` **un-awaited** and marched on to `saveData()` / `orbRiskState.recordDay()` / `notifyDayReport()` while the sell was still at the broker.

- Stopping a live session holding a real position persisted a session **missing its final trade**, and when that was the day's only trade `if (state.sessionTrades.length)` was false so **the entire session was never saved** — `data.totalPnl` and displayed capital silently lost it. Exit at ₹300 from a ₹240 entry, qty 65 → **+₹3,814 vanished from live capital**. The weekly-loss and losing-streak breakers were fed the same understated number.
- `stopSession` is now `async` and awaits the exit before any bookkeeping; `state.running` is cleared first so no tick or candle close is processed during the round-trip. Its three callers — `/orb-live/stop`, the 15:30 auto-stop, and `gracefulShutdown` in [app.js](src/app.js) — now await or `.catch()` it, so a rejected exit can no longer vanish. `/orb-live/exit` awaits too, so the redirect no longer renders a position that has already been closed.

**Root cause 2 — gates added to paper were never mirrored into live.**

- **The portfolio-wide daily loss cap ran in paper only.** With `PORTFOLIO_MAX_DAILY_LOSS=12000` and the book at −₹12,400, paper stopped entering while live kept trading real money. Now applied in live at the same position in the sequence. (Currently unset, so it was inert.)
- **Entry-gate order was swapped**: paper checks max-trades before daily-loss (deliberately — its comment records that the reverse spammed 200+ `daily_loss` skip rows a day without changing any outcome); live had it the other way.
- **Live had no "past `ORB_FORCED_EXIT`" start guard**, so it would open a session paper refuses.
- **The expiry-day block returned silently** in live; paper skip-logs `expiry_day_only`. All nine skip-log gates now match exactly.
- **The option-quote fetch error was swallowed** (`catch (_) {}`) where paper logs the cause.
- **`tickRecorder` had zero call sites in live and six in paper**, so live sessions left no audit/replay record. All six mirrored (session start/stop, entry, exit, and both option-LTP paths).

**Root cause 3 — persistence fidelity.** Live re-snapshotted the position when breakeven lifted the stop; paper did not, so a crash after breakeven recovered the pre-breakeven stop (CE entered 24,000, stop lifted 23,961 → 24,000; paper recovered 23,961). The one-line re-snapshot was added to **paper**: it is persistence only — no decision, fill or exit changes — and the alternative (deleting live's) would have degraded real-money crash recovery.

Five new mutation-tested assertions pin the parity properties: identical entry-gate sequence, identical skip-gate set, `stopSession` awaiting the exit before saving, every caller observing its promise, and both modes re-persisting on breakeven. Suite now **36 ORB assertions** (`npm test`: 28 + 36).

### Fixed — ORB backtest hid the entry gates it cannot model (one of them ships ON)

Recheck pass over the live-execution path — `orbLiveHarness.js`, crash recovery, and the offline-vs-paper gate surface. One real gap.

- **The backtest's own disclosure said "premium/spread gates apply in paper/live only".** It omitted the **OI buildup filter, which is enabled in the shipped config** (`OI_FILTER_ENABLED=true` + `ORB_OI_ENABLED=true`), and the VIX gate. Those gates need a live option chain / VIX quote, so no offline engine can run them — meaning **the 9-trade study is an upper bound**: paper takes those trades or fewer, never more. Anyone comparing "backtest says 9, paper took 6" would have chased a phantom engine bug. The note is now built from the live env (`_paperOnlyGates()`) instead of being a hard-coded sentence that goes stale the moment a toggle flips, and it appears in both the results page and the saved `notes` field. New mutation-tested assertion; suite now **31 ORB assertions** (`npm test`: 28 + 31).

**Verified clean in this pass, no change needed** — the live harness path in particular, which had not been audited since the rebuild:

- **`/orb-live-harness/stop` cannot orphan a real position.** `simulateSell` is fully synchronous and fires `notifyExit` before returning, and the route invokes paper's `/stop` (which squares off any open position) *before* uninstalling the harness — so the real exit order goes out while the hook is still installed. The error path uninstalls too, but only after the same call.
- **Crash recovery covers the harness path for ORB**, contrary to a standing note that said `.active_*_position.json` was written by the legacy `*Live.js` routes only. `orbPaper.js` persists on entry and clears on exit, and the harness *runs* paper; `app.js` reconciles that snapshot against the Fyers book on boot, and its `_liveActive` guard counts `LIVE_HARNESS_DRY_RUN=false` as well as `ORB_LIVE_ENABLED`, so a harness-only live session is not mistaken for paper.
- The double gate holds: real orders need `ORB_LIVE_ENABLED=true` **and** both dry-run flags off, checked before the harness installs.

### Fixed — ORB: offline engines ran the exit stack in the wrong order, and two config dials did nothing

Full 13-phase institutional review. Two correctness bugs, two phantom config keys, one corrected headline number.

**Exit precedence — the offline engines had paper's timeline backwards.** Paper runs `_checkExits` on **every tick** (rupee cap → premium stop → hard SL) and `_managePositionOnClose` only when a candle **closes** (opposite candle → breakeven → EMA trail). So inside one candle the intrabar exits always get first refusal. Both `orbBacktest.js` and `scripts/orbValidate.js` evaluated them the other way round, letting a close-based rule book the candle's *close* on a bar where paper had already been stopped out minutes earlier. Reordered to match. Impact on the 39-session sample is small (net ₹3,868 → ₹3,878) because only one candle straddled both, but the exposure is unbounded on other samples — a bar that dips 60pt through the stop and recovers to a clean trend close was scored as a winner.

**The EOD square-off was a candle late.** Paper checks the clock on every tick and exits at the first tick at/after `ORB_FORCED_EXIT`; the backtest booked `c.close` of that candle — five free minutes the live engine never gets. Now fills at `c.open`.

**`scripts/orbValidate.js` — which produces the number quoted in the strategy header — modelled a gentler strategy than the one that trades.** It armed breakeven off the intrabar **high/low** rather than the **close**, so any trade that merely *touched* +20pt and gave it straight back was scored as a scratch instead of a loss; and it modelled **no opposite-candle exit at all**, which is ON by default in paper. Both fixed. The corrected authoritative figures on the only sample available (39 sessions, Mar–Apr 2026):

| | old (wrong) | corrected |
|---|---|---|
| net | ₹3,112 | **₹3,415** |
| profit factor | 1.39 | **1.44** |
| P(true edge ≤ 0) | ~39% | **~37%** |
| best trade as % of net | 231% | **211%** |
| net without the best trade | −₹4,089 | **−₹3,786** |

The conclusion is unchanged and unflattering: **strip one trade out of nine and the strategy loses money.** It also confirms the rupee budget clamped the stop on **9 of 9** trades — `ORB_SL_ATR_MULT` is fully inert at the shipped `ORB_MAX_TRADE_LOSS`.

**Removed two config keys that could not change any automated trade** (Phase 2: a parameter with no measurable value is a liability):

- `ORB_TARGET_RANGE_MULT` — `targetSpot` drives no exit anywhere; it is a chart line. Worse, the strategy hard-coded `1.5` for auto signals while only the *manual-entry* path read the env key, so changing it moved the line on manual trades and nowhere else. The strategy now exports `TARGET_OR_MULT` and both routes use it — one owner.
- `ORB_LIVE_CAPITAL` — appeared in no `.env`, no Settings field and no doc, yet silently overrode the live dashboard's starting capital, so live and paper could disagree. Live now reads `FYERS_INV_AMOUNT`, identical to paper, matching the documented collapse of per-strategy capital keys into broker pools.
- `ORB_PAPER_CAPITAL` deleted from `.env` — dead since that same collapse; paper reads `FYERS_INV_AMOUNT`.

Three new assertions, all mutation-tested: intrabar exits precede close-based exits in *both* offline engines; the validation script models paper's exits rather than a friendlier subset; the removed keys cannot resurrect. Suite now **30 ORB assertions** (`npm test`: 28 + 30).

**Verified clean in this pass, no change needed**: every `/orb-paper` and `/orb-live` page renders 200 with no `undefined`/`NaN` leaking into the HTML (the three `undefined` hits are `typeof` guards in client JS); the manual-entry synthetic-signal path reconciles its stop through `orbStopRisk` like every other entry; `realtime.js`, `consolidation.js` and `replay.js` are all still wired for ORB; the removed signal fields (`volRatio`, `wickRatio`, …) survive as explicit `null`s so historical trade records keep a stable shape; the risk breaker (`orbRiskState`) and OI gate are genuinely called by both paper and live; every ORB key read in code appears in the README and no key in `.env` is unread.

**Remaining risk, unchanged and blocking**: 9 trades is not a validated edge. `scripts/orbValidate.js --from 2024-01-01` needs a live Fyers token and must be run before `ORB_LIVE_DRY_RUN` is turned off.

### Fixed — ORB backtest: the rupee cap overshot the very budget it enforces

Second recheck pass. This one ran the backtest end-to-end for the first time since the rebuild — a path never executed in the previous passes, only reasoned about.

- **The per-trade rupee cap booked its exit at the candle's worst extreme.** Paper and live check the cap per tick and fill at that tick; the backtest compressed a 5-min bar and filled at `c.low`/`c.high`, so the realised loss ran well past the ₹1,500 it exists to enforce — **−₹2,052 observed, 37% over budget.** It now fills at the spot level the threshold actually implies (`premium drop ÷ delta`), while still honouring gap-through: if the bar *opened* past that level, the fill is the open. Net on the study sample ₹3,545 → ₹3,868, and the worst trade tightens from −₹2,052 to −₹1,781 — the residual is exactly the cost overlay (₹195 slippage + ~₹86 charges), which paper and live incur too.
- **The backtest now has end-to-end coverage.** Three new assertions: it runs and every trade record is free of `undefined`/`NaN`; no trade loses materially more than budget-plus-costs; and the cap fills at its threshold rather than the bar extreme. Mutation-tested — restoring the old bar-extreme fill fails 2 of them.

Suite now 27 ORB assertions (`npm test`: 28 + 27).

**Verified clean, no change needed**: backtest and `scripts/orbValidate.js` agree on the same 9 trades over the same sessions (₹3,868 vs ₹3,112, the gap being the δ/θ premium sim versus the linear cost model), so the two independent paths corroborate each other.

### Fixed — ORB: the skip log now really carries the gate funnel (the docs claimed it already did)

Recheck pass over the previous three commits. One documentation claim was false, one label was stale; everything else verified clean.

- **The README and CHANGELOG both stated that the skip log records the full gate funnel "rather than only the first blocking reason". It did not** — the `signal_none` skip row carried `sig.reason` and nothing else, so the funnel existed in memory and was thrown away. Now wired for real, via a new `summarizeGates()` that encodes the whole funnel compactly (**77 bytes**, e.g. `time window:P,trade budget:P,OR ready:P,OR vs ATR15:P,gap sanity:P,breakout:F`) rather than embedding ~10 objects on every 5-min row. Two new tests assert both that the encoding covers *every* gate and that both routes actually write it, so the claim cannot silently rot again.
- **Stale Settings label** — `ORB_ITM_STEPS` was still labelled "V3 — …" months after the V3 engine was deleted. Its description now also notes that the ~0.6 delta it implies is what converts *Max Trade Loss* into the stop distance, so changing the strike step changes the effective stop width.

**Verified clean in this pass** (no change needed): the full app boots with no errors beyond expected broker-auth failures; both test suites pass (28 + 24); every ORB key in the Settings UI is genuinely read somewhere in `src/`; no ORB key in `.env` is unread; `sig.gates` does not leak into trade records or the tick recorder; the ORB position-persistence round-trip preserves the clamped stop.

**One earlier finding retracted**: an audit sweep flagged `ORB_ITM_STEPS` as read by no code. That was a false positive — `instrument.js` reads it through a computed key (`process.env[\`${mode}_ITM_STEPS\`]`) that a literal grep cannot see. Slightly-ITM strike selection works correctly, which also confirms the ~0.6 delta assumption used by the stop clamp.

### Fixed — ORB: live crash-recovery gap, a trace hole, and the first ORB test suite

- **BLOCKER — ORB Live never persisted its position.** `orbPaper.js` wrote a crash-recovery snapshot; `orbLive.js`, which places **real Fyers orders**, did not — exactly backwards. `app.js` calls `loadOrbPosition()` on boot, so a restart mid-live-trade found nothing to reconcile: the user was left holding an untracked option with no orphan warning, while every other live route (`bbRsiLive` / `paLive` / `emaRsiStLive`) already persisted. ORB Live now snapshots on entry, **re-snapshots when the stop lifts to breakeven** (so recovery sees the current stop, not the entry stop), and clears on exit. Round-trip verified including the clamped stop level.
- **The gate trace was missing on the warm-up path.** `getSignal()` returned before the tracer existed when fewer than 2 candles were available, so `sig.gates` was null and the skip log silently lost the funnel for those candles. The tracer is now created before every guard, so **every** return path carries a trace. Found by the new test suite, not by inspection.
- **`ORB_SL_ATR_MULT`'s Settings description was misleading** — it still promised a 50–83pt stop without saying the ₹1,500 cap clamps it to ~38pt. It now states plainly that the knob is **inert at the default budget** (every value 1.0–2.5 behaves identically, verified on 39 sessions) and that real risk is changed via *Max Trade Loss*.

**First ORB test suite — `tests/orb.regression.js`, 22 assertions, wired into `npm test`** (which now runs both suites: 28 + 22). Every assertion guards a defect found in this audit:
- *Capital-safety invariants* — the clamp holds across every qty × stop-width × side combination (risk can never exceed the budget), clamps on the correct side for PE, honours `ORB_MAX_TRADE_LOSS=0` as an opt-out, never produces `NaN` from a null/garbage stop, and always names the binding constraint in its note.
- *Engine invariants* — never enters before 09:30 or after the cut-off, the opening range never repaints, **no look-ahead** (withholding future candles cannot change a signal or its stop), entry is always a bar close, the stop is always on the correct side, the day-sanity gates actually hold on every entry taken, and the only gate permitted to FAIL on an entry is `confirmation` — and only when the documented retest fallback justifies it.
- *Anti-regression* — the six deleted config keys (`ORB_PRIORDAY_LEVEL_FILTER`, `ORB_CLOSE_POS_PCT`, `ORB_ENTRY_V2/V3_ENABLED`, `ORB_OR_ATR_MIN`, `ORB_RETEST_MODE`) provably no longer change behaviour, so a stale `.env` cannot resurrect them.
- *Mode parity* — all three routes resolve the stop through `orbStopRisk` and none recomputes its own; paper **and** live both persist and clear; both entry paths guard the await window.

Mutation-tested: reverting the clamp fails 4 assertions, so the suite bites rather than merely passing.

### Fixed — ORB: reconcile the two conflicting stops, and ship the validation the review demanded

Acts on the adversarial re-review below. Two real defects fixed, one blocker removed.

- **The advertised stop was not the executing stop.** ORB carried two independent stops that disagreed: `sig.slSpot` (wider of the entry-candle extreme and `ORB_SL_ATR_MULT`×ATR5) at 50–83 spot pts, and `ORB_MAX_TRADE_LOSS` at ₹1,500 which on a 65-lot ~0.6-delta option trips after only **~38 spot pts**. The cap ended essentially every losing trade while the dashboard, the Telegram alert and the trade record all showed the wider level. New [src/utils/orbStopRisk.js](src/utils/orbStopRisk.js) reconciles them — the placed stop is the tighter of the two, so **what you see is what executes** — and logs whenever it clamps, making "the rupee budget is your real constraint" visible instead of silent. On the study sample it clamps on **9 of 9 trades**. P&L is unchanged (production already behaved this way); what changed is that the displayed level is now true. Raise `ORB_MAX_TRADE_LOSS` if you want the full ATR stop — that is a capital decision, so the default is the conservative direction.
- **Applied identically in paper, live and backtest**, so the three modes place the stop at the same level. Previously the backtest used the 50–83pt stop while paper/live really exited at ~38pt on the cap — a silent backtest-vs-reality divergence.
- **Removed duplicated logic**: the previous commit had copy-pasted the same risk-note helper into both routes. It now lives once, in the new module.
- **New `scripts/orbValidate.js`** — the 250–500-session validation the review called for, as one command: `node scripts/orbValidate.js --from 2024-01-01 --to 2026-04-30`. It drives the real `getSignal()` plus the full production exit stack, prices trades in rupees with costs, and reports bootstrap CI, P(edge ≤ 0), single-trade concentration, per-regime breakdown (trend/chop, volatility, gap, side, exit type) and year/quarter stability. It writes nothing and places no orders. Still needs a Fyers token; that is now the only thing standing between here and a real answer.

**The numbers got worse once measured properly.** Running the full production exit stack (the *adaptive* breakeven `max(20, 0.5×OR)`, which earlier ad-hoc sims had simplified to a flat 20pt) on the same 39 sessions gives **9 trades, 33% win rate, net ~₹3,112, PF 1.39** — with **P(true edge ≤ 0) ≈ 39%** and the best trade worth **231% of net (remove it: −₹4,089)**. Earlier figures in this changelog ("+346 spot points, no losers", then "~₹6,737") were both optimistic. `scripts/orbValidate.js` is now the authority; distrust any ORB number quoted from memory.

**Strongest untested hypothesis, recorded rather than acted on**: a *narrow* opening range was the entire edge on this sample — `OR < 1.5×ATR15` gave 4 trades / 75% win / +₹10,700, `OR ≥ 1.5×ATR15` gave 5 trades / 0% win / −₹7,587. Mechanically sensible. It is n=9, so `ORB_OR_ATR_MAX` was deliberately **not** tuned to it. Test it first on the long sample.

### Changed — ORB: adversarial re-review of the rebuild (claims corrected, no strategy logic changed)

Independent review of the rebuild in the previous entry, run specifically to try to disprove it. **No entry or exit logic changed.** What changed is what we claim, plus one disclosure fix. Findings:

- **The headline "+346 spot points, no losers" was a spot-points artifact.** With realistic option costs modelled (delta 0.6, 1.5pt slippage per side, theta, charges) the same 9 trades are **3 winners and 6 losers netting ~₹6,700**, and modelling the `ORB_MAX_TRADE_LOSS` cap — which neither study did — takes it from ₹9,736 to **₹6,737**.
- **`ORB_SL_ATR_MULT` is inert.** The rupee cap (₹1,500 / 65 lot / ~0.6 delta ≈ **38 spot pts**) is tighter than the ATR stop (50–83pt), so it ends essentially every losing trade. Every multiplier from **1.0 to 2.5 gives an identical result**, as does the plain OR opposite edge. The stop redesign's real content was only that the *old* stop was tighter than the cap and fired first — direction supported, magnitude untested. Real risk is governed by `ORB_MAX_TRADE_LOSS`, not by this multiplier. Both routes now **log which stop binds at entry** so the dashboard's SL cannot mislead.
- **The evidence is not statistically significant, and this is now stated everywhere.** Bootstrap 95% CI on mean-per-trade is **[−₹1,029, +₹2,998]** — a ~**25% chance the true edge is zero or negative**. One trade is **81%** of all profit; leave-one-out turns the result to ₹1,843. Reaching 95% confidence / 80% power needs **~147 trades ≈ 637 sessions ≈ 2.5 years**. The prior-day-filter removal is Fisher-exact **p = 0.152**.
- **Selection bias identified in the ablation itself.** Tightening `ORB_BODY_ATR_MULT` (0 → 1.0) or `ORB_OR_ATR_MAX` (2.5 → 1.5) improves every metric *monotonically* (PF 1.4 → 14.6 / 29.3) purely by dropping scratch-cost trades while the 2–3 known winners survive at every threshold. Those curves are not evidence and must not be used to tune.
- **Parameter sensitivity is otherwise healthy** — no cliffs. Breakeven is flat over 10–25pt; the ATR stop is flat over 1.2–2.5; the EMA trail is smooth (9 too tight, 13–55 within noise, 34 actually beat the shipped 20). Nothing shows the knife-edge behaviour that signals curve-fitting.
- **Corrected an earlier call**: the entry cut-off. Widening to 14:30 looked *worse* in the original spot-points study but *better* in rupees under the final exit model (+₹15.6k vs +₹9.7k) while also producing the worst single trade. Genuinely undetermined; left at 11:30 on structural grounds only.
- **Verified**: backtest, paper and live apply the same rupee cap, premium stop and strategy-owned `sig.slSpot` — no execution drift found.

**Not reverted, and why.** The prior-day filter stays deleted despite p=0.152: it cut 100% of the sample's winners, and with it enabled ORB took 1 trade per 39 sessions — unvalidatable in any practical timeframe. The V1/V2 deletions stand (V2 took 0 trades in 39 sessions). The race fix and the single-owner stop are correctness work needing no statistical support.

**Only remaining data blocker**: no Fyers token and no cache beyond Mar–Apr 2026, so the 250–500-session validation the review calls for could not be run. It should be run before `ORB_LIVE_DRY_RUN` is turned off.

### Fixed — EMA_RSI_ST production sign-off: spot was booked as an option premium, EOD killed the shared socket, backtest drifted from paper

Multi-cycle audit run as a pre-production certification. The strategy module ([strategy1_sar_ema_rsi.js](src/strategies/strategy1_sar_ema_rsi.js)) is untouched except for exporting `isInTradingWindow` — 10 insertions, 1 deletion, all in the export block. No indicator, threshold, window, sizing or expiry value changed anywhere in the diff.

**The finding that reframed the rest: [emaRsiStLiveHarness.js](src/routes/emaRsiStLiveHarness.js) runs EMA_RSI_ST live by *wrapping paper*** — "the strategy is whatever emaRsiStPaper says it is". Every paper defect below is therefore a real-money defect, not paper hygiene.

- **Critical — a spot price was written into an option-premium field, force-closing the trade at a ~₹15L phantom loss.** When option polling returned nothing for 10s (a rate-limit hit sets `_rateLimitSkipCycles = 2`), the fallback stamped `ptState.lastTickPrice` — spot, ~₹23,800 — into `position.optionEntryLtp`, which every consumer reads as a premium (~₹180). The 25% option stop then evaluated `182 <= 23800 × 0.75 = 17,850` → **true**, squaring off ~1s after the real premium finally arrived, and `simulateSell` booked `(182 − 23,800) × 65 = −₹15,35,170` as a genuine trade — instantly latching the ₹2,000 daily cap and ending the day. The `if (!optionEntryLtp)` guard meant the real premium never replaced it. Through the harness that phantom exit is a real Zerodha order. The field is now left null so the designed *"spot proxy (option LTP unavailable)"* P&L mode and the inert-option-stop path take over, and this contract's own first poll sets it. Same fix in the legacy live route, where it additionally resurrects the exchange stop: `placeHardSL()` is only ever called from the two `if (!optionEntryLtp)` branches, so stamping the proxy made both permanently unreachable — with `HARD_SL_ENABLED=true` the SL-M was silently never placed and the "HARD SL FAILED" alert never fired either, because it lives inside the function that was never called.
- **High — the EOD auto-stop tore the shared Fyers socket out from under other running strategies.** Three sites still used a `!isBbRsiActive() && !isEma9VwapActive()` guard that omits PA / ORB / TREND_PB. The correct `isAnyActive()` guard already existed two lines away in `/stop`, whose own comment names the strategies at risk — the fix had simply never been applied to the EOD paths. Run PA Paper alongside EMA_RSI_ST and at `TRADE_STOP_TIME` PA lost its feed: no candles, no per-tick stop, no square-off.
- **High — paper's candle-close rules could run against a position opened in the *next* bar.** `onCandleClose` is fire-and-forget from the tick handler and awaits `oiFilter.recordOiSample()`, which does a real `getQuotes` round-trip when OI filtering is on. The boundary tick's intra-bar entry completes inside that window, so bar N's block then acted on a bar N+1 position: `candlesHeld` incremented for a bar never held (firing the 2-candle negative stop a bar early), bar N's EMA21 trail overwriting the stop just resolved for the new entry, and — because the touch-back "skip on entry bar" test compares `candle.time` to `entryBarTime` — a brand-new position closable by *"EMA touch-back exit"* computed from the previous bar's range. Now gated on position identity captured before the await. Live never had this; its `onCandleClose` has no await before the same block. The hard EOD square-off is deliberately left ungated so any open position is still closed.
- **High — the backtest silently dropped entries paper takes, and mis-timed the negative-candle stop.** Paper arms on *flat + valid signal* only and checks every risk guard at fill time inside `simulateBuy`; the backtest armed inside its guard-gated entry block, so a signal on the **last candle of a pause** never armed at all. Fixing that exposed a second hole it had been masking: the confirmation-fill path never applied the same-side SL pause, the opposite-side cooldown or the VIX gate — 14 entries landed inside a live SL pause, and with VIX on + fail-closed the counterfactual took 71 trades that should have been 0. Separately, `candlesHeld` was incremented at the top of the candle loop while paper increments at the top of `onCandleClose` and tests the rule immediately after, so the 2-candle negative stop fired a full bar late. Also added: same-bar exit parity on the intra-bar confirm fill (0 → 16 on the April sample), entry-window enforcement on the confirmation candle, a shared protective-stop resolver (10 non-protective initial stops → 0) and one shared indicator-history depth. April 2026: 68 trades / −₹12,277.02 → 71 / −₹8,933.52.
- **Medium — Settings changes never reached the live engine, and paper's entry window went stale.** Live froze every session key at module load with no refresh, so a Settings edit needed a full process restart; paper refreshed `_STOP_MINS` but left `_START_MINS`/`_ENTRY_STOP_MINS` as module-load `const`s, so raising `TRADE_STOP_TIME` from 15:30 to 16:00 extended the session while entries stayed blocked from 15:20. Both engines now refresh at `/start` from one source. `isMarketHours()` is also keyed on the IST minute rather than a 60s wall-clock TTL, which had let an entry through up to ~59s past the cutoff.
- **Medium — paper's daily-loss kill switch reset to ₹0 on every restart.** Live already re-armed from today's realized P&L; paper did not, so a stop→start (or crash + PM2 restart) handed the same day a fresh loss budget — and via the harness that is the real-money cap. Prior realized P&L is tracked in a separate field so `saveSession()` cannot double-count it on the next restart, and the recovery is skipped during replay, which patches `Date.now()` and would otherwise seed the replayed day with its own recorded result and return zero trades.
- **Medium — paper had no option-LTP staleness tracking.** A failed poll left `ptState.optionLtp` frozen indefinitely with no timestamp and no warning, so the 25% option stop and the exit P&L could both run off an arbitrarily old premium. Mirrors live's 15s alert; warning only, exit rules unchanged.
- **Low — `saveSession()` stamped the UTC date** (the same trap this file warns about in `/start`), and boot reconciliation counted a crash-snapshot record with no `.position` as a snapshot, producing a spurious "retaining unverified snapshot" warning.

Verified: **100 assertions, 0 failed** across three suites, 13 of them mutation-proven — each re-introduces its exact defect and is checked to flip to fail, so a vacuous assertion is reported as VACUOUS rather than as a pass. Backtest deltas measured against `git HEAD` on 1,500 real April 2026 NIFTY 5-min candles.

### Fixed — EMA9+VWAP production sign-off: replay could kill the live tick feed, one toggle bricked entries, /simulate corrupted paper history

Fifth independent audit, run as a pre-production certification. Nine verified defects; the strategy module ([ema9_vwap.js](src/strategies/ema9_vwap.js)) and the live harness were **not** touched. Shipped-default behaviour is byte-identical — the backtest returns the same trades under every config tested, including the one the re-entry change targets.

**Root class: lists written for the original four strategies that nobody extended when EMA9VWAP and TREND_PB were added.** Three of the worst defects were instances of it, so the fixes are enforced by tests that assert the rule for *every* strategy, including the next one added.

- **Critical — a Replay could silently kill the live Fyers tick feed, or brick the paper engine.** [tickReplay.js](src/services/tickReplay.js) stubs `sharedSocketState` mutators so a replay can't touch the real socket mutex — but the stub list covered only EMA_RSI_ST/BB_RSI/PA/ORB. An EMA9+VWAP replay therefore mutated the **real** mutex: `/start` set it, `/stop` cleared it. Run a replay while EMA9+VWAP was genuinely live and its flag was cleared underneath it — the next sibling to stop then saw `isAnyActive() === false` and called `socketManager.stop()`, killing the shared feed for a session with an **open live position** (no ticks → no candles → no exits). If instead the replay threw before `/stop`, the flag stayed set and `/ema9vwap-paper/start` refused forever with *"Live Trading is currently active"*, while `/ema9vwap-live/stop` answered *"Harness not installed and paper engine not running"* — unstartable until a PM2 restart. Compounding it, `replayPreflight()` (the "don't replay while a strategy is running" guard) never checked `isEma9VwapActive()`, and `forceClearSharedState()` — the documented `POST /replay/force-clear` recovery path, also called in `runReplay`'s `finally` — could not clear it. All three lists now cover every strategy; TREND_PB had the identical hole and is included.
- **High — `EMA9VWAP_CONFIRM_CANDLE_ENABLED=true` stopped the strategy trading entirely.** `onCandleClose` skips both of its entry blocks when confirm is on, because entry is meant to move to the next bar's intra-bar cross — but that confirm-consume sits inside the `_intraCandleEntryEnabled()` gate, and `EMA9VWAP_INTRACANDLE_ENTRY` defaults to `false`. Result: every cross logged `🎯 ARMED CE`, the status page showed *"waiting for next candle to cross …"*, and zero trades were taken. BB_RSI evaluates its armed signal at the top level of its tick handler for exactly this reason. The gate now admits `_confirmEnabled()` too; when it does, the block rewrites `signal` from the armed state so the raw forming-bar signal still cannot enter.
- **High — `/simulate` wrote its synthetic trades into the canonical paper record.** `onSimDone()` cleared `_simMode` but left `ptState.running` true, so the user's Stop click reached `saveSession()` looking like a real session: it pushed the scenario's trades into `ema9vwap_paper_trades.json`, moved `capital`/`totalPnl` by the simulated P&L, Telegrammed a day report for a session that never happened, and `simulateSell` had already appended every trade to `trades/ema9vwap_paper_trades_YYYY-MM-DD.jsonl` — the audit log the tuning workflow treats as truth, carrying today's date and a real option symbol. A sticky `_simSession` flag (set in `resetSimState`, cleared only by `/start`) now gates the trade log, the session save and the crash-recovery snapshot.
- **High — the entry gate tested a value this strategy never sets.** `(TRADE_RES === 5 || _cachedClosedCandleSL !== null)` is a leftover from the SAR strategy. `getSignal()` returns `stopLoss: null` for EMA9+VWAP, so the clause held only via `TRADE_RES === 5` — at the 3-min and 15-min options Settings offers, it silently disabled intra-candle **and** confirmation entry. Removed; "at least one candle has closed" is already covered by `ptState.candles.length >= 30`. No change at 5-min.
- **Medium — `TRADE_EXPIRY_DAY_ONLY` failed OPEN on the intra-candle path.** `_expiryDayBlocked` was honoured by the candle-close entry only, so with intra-candle entry on the filter logged *"Not expiry day — entries blocked"* and then entered anyway.
- **Medium — backtest blocked same-bar re-entry after a protective stop; paper does not.** Paper's points/option/trail stops `return` from the *tick* handler only — the bar still closes and `onCandleClose`'s entry section runs, with the two cooldowns as the real guard. Paper is canonical, so the backtest moved to match. Verified byte-identical on both cached months with the cooldowns off.
- **Low — `/start` silently discarded a retained crash-recovery snapshot.** The boot reconcile deliberately keeps `.active_ema9vwap_position.json` when the broker book reads empty (empty is indistinguishable from a swallowed API error) to re-check next boot; a Start in between erased it without a word. It now logs and Telegrams what it is discarding.
- **Low — `resetSimState()` leaked state into simulations.** Missing `_chopConsecLosses` / `_skipSignalCtx` / `_sessionId`, all of which `/start` resets. A chop guard latched by a prior session produced a silent 0-trade simulation that read as "no signals found".
- **Low — `saveSession()` stamped sessions with a UTC date** while every other date in the file uses IST. Only diverges for a save between 00:00 and 05:30 IST (reachable via a night-deploy `stopSession()`).

Verified: `npm test` **28 assertions, 0 failed**, with all eight new assertions mutation-tested (reverting each fix fails exactly its own test). Every `EMA9VWAP_*` key read anywhere in `src/` is present in both the Settings UI and README.

### Changed — ORB rebuilt: one engine, 9-key signal surface, ATR-based stop

ORB had degraded to **1 entry in 39 sessions**. A gate-attribution replay over real Mar–Apr 2026 NIFTY 5-min candles found the cause, and a per-gate conditional-edge study decided what to keep. Every removal below is backed by that measurement, not by preference. `src/strategies/orb_breakout.js` carries the full ablation table in its header.

**Why it stopped trading**
- **`ORB_PRIORDAY_LEVEL_FILTER` had negative edge.** It required the 09:30–10:30 close to already clear the *entire* prior day's range. On the raw breakout population it **kept 7 trades at 0% win rate / −7.2pt average** while cutting 6 worth **+290.8pt — including both winners**. It is anti-correlated with the actual edge: the two winners came from the two *narrowest* opening ranges, and a narrow-OR day almost never clears PDH/PDL inside the first hour. **Deleted.**
- **`ORB_CLOSE_POS_PCT` was a silent key collision.** V3 read the key that Settings and `.env` own as a *V2* value (`0.20`), overriding V3's intended `0.25`. **Deleted** — the gate itself measured weak-to-negative (removing it took net 132.9 → 346pt).
- **The V2 engine took 0 trades in 39 sessions** and V1 was legacy. Both **deleted**, along with the `ORB_ENTRY_V2_ENABLED` / `ORB_ENTRY_V3_ENABLED` switches and the whole RSI / ADX / EMA20-50 / wick-% / volume / sweet-spot / fixed-point-range config surface.

**The stop was killing the winners.** Each route recomputed its own initial SL as the entry candle's opposite extreme. But that candle is *by construction* a large-body momentum bar, so the stop sat ~one body away — exactly where the normal retracement lives. Measured median width **23pt, hit on 4 of 6 trades**, including the session that then ran 213pt our way. The stop is now the **wider of the structural extreme and `ORB_SL_ATR_MULT=1.5 × ATR(5m)`**, and it is owned by the strategy (`sig.slSpot`) — paper, live and backtest all consume the same value instead of each deriving one, so the three modes cannot drift. Worst-case rupee risk is **unchanged**: `ORB_MAX_TRADE_LOSS` / `ORB_PREMIUM_STOP_PCT` bind first.

**Kept, with evidence** — the `0.6×ATR(5m)` body gate (removing it took the worst trade from 0 to −80pt and PF from ∞ to 3.3), the `OR ≤ 2.5×ATR(15m)` day filter, the gap filter, the VWAP side check, the one-candle confirmation, and the breakeven at +20pt (removing *that* cost 106pt and introduced a −77pt worst case). EMA20 close-trail beat EMA9 and was preferred over a chandelier trail whose results were non-monotonic in the multiplier — i.e. noise.

**Net on the study, exits and data identical: 1 trade / 0pt → 9 trades / 3 winners / +346 spot points.** Stated plainly: two trades carry nearly all of that, 39 sessions cannot prove an edge, and ORB remains a right-tail strategy with many scratches. Collect clean paper sessions before enabling live.

**Also**
- **Duplicate-entry race closed.** `state.position` / `tradesTaken` were only set *after* two network round-trips inside the entry path, and `onCandleClose` is fire-and-forget from `onTick` — a candle close landing in that window would see a flat book and open a second position (in live, a second **real order**). Both paper and live now guard the await window.
- **`ORB_DEBUG_TRACE`** (default off) prints the full per-candle entry funnel — every gate PASS/FAIL/SKIP with its numbers and the final decision. The same trace always rides back as `sig.gates`, so the skip log records the whole funnel instead of only the first blocking reason.
- **Config surface cut from 66 Settings entries to 35** (signal surface: 9). `ORB_ATR_PERIOD`, the breakout-buffer multipliers and the retest tolerances became constants — structural choices, not tuning dials.
- **`ORB_LIVE_DRY_RUN` flipped to `true`.** A rebuilt strategy should not be able to place a real order before a paper session validates it.

### Fixed — EMA9+VWAP red-team pass: a crash, a default-config EOD drift, two missing guards

Fourth independent audit. Paper and the strategy module were **not** touched; every defect was in the backtest engine (plus one wrong log line).

- **Critical — `TRADE_EXPIRY_DAY_ONLY=true` crashed the whole backtest.** The expiry-date block read `total` about 25 lines above its own `const total = candles.length;`, so turning the filter on threw `ReferenceError: Cannot access 'total' before initialization` and aborted the run. It never surfaced because `&&` short-circuits on the default (filter off) and `total` is only reached when the filter is ON. Introduced by the previous parity commit; `total` is now declared before its first use.
- **High — EOD square-off fired one bar late, on the DEFAULT config.** Paper squares off inside `onCandleClose`, which runs when a bar *closes*, comparing the wall clock at that instant against `EMA9VWAP_EOD_EXIT_TIME`. The backtest compared the bar's *start*, so with the 15:15 default paper exited on the 15:10 bar (it closes at 15:15) while the backtest waited for the 15:15 bar and booked its 15:20 close. Now gated on the bar's close, matching `strategy.isEntryWindowOpen()`. This **changes default backtest numbers** — one trade per month (the one that runs to EOD): Mar-26 −₹18,963 → −₹18,742, Apr-26 +₹594 → +₹346. It is a correction toward paper, not an improvement.
- **High — same-side SL cooldown was missing.** Paper's `_setSlPause` blocks re-entry on a stopped-out side for `EMA9VWAP_SL_PAUSE_CANDLES` (default 3) after a points-stop / option-stop / trail-SL hit. The backtest had no equivalent, so with any optional stop enabled it re-took the same side on a bar paper still had blocked. Mirrored, armed by exactly those three exits.
- **Medium — chop guard was missing.** `EMA9VWAP_MAX_CONSEC_LOSSES` (default 0 = off) halts entries for the rest of a session after N straight losses in paper; the backtest ignored it entirely.
- **Low — the live harness logged the wrong confirmation-candle default.** With the key unset, `/ema9vwap-live/start` printed `confirmation candle: ON` while the paper engine underneath ran it OFF. Log string only.

Verified: `npm test` **20 assertions, 0 failed**; every new assertion mutation-tested (reverting each fix fails exactly its own test). Defaults are unchanged apart from the EOD trade documented above.

### Fixed — EMA9+VWAP: backtest exit PRECEDENCE did not match paper

Found on a further red-team pass. Paper runs the protective stops in `onTick` — they fire on the ticks of a bar using the level set at the PREVIOUS bar's close, i.e. **before that bar ever closes** — and only then does `onCandleClose` run the time-stop and negative-candle checks. The backtest evaluated the candle-close rules FIRST, so whenever two rules fired on the same bar it attributed the exit to the wrong rule and (now that stops book their own level) to the wrong price.

Real numbers on 20 April-2026 sessions with a 25pt points stop + 2-candle negative-candle stop both enabled: **₹3,750 → ₹2,780** and three bars re-attributed from `Negative 2-candle stop` to `SL (25pts)` — the old order was reporting results ~26% better than paper would produce. Order is now `[points, option, trail-hit] > [time-stop, negative-candle] > [trail re-arm] > [reversal] > [signal] > [EOD]`.

Also: the time-stop and negative-candle stop now measure P&L in **option-premium points** (the same δ+θ model the P&L sim uses) rather than raw spot points, because that is what paper measures — a theta-bled but spot-flat trade is red to paper and was green to the backtest.

Default config is byte-identical (20 trades / ₹2,735 before and after) since every stop involved defaults to OFF, and paper signals are unchanged (0 diffs / 1,389 evaluations). The new regression assertion is mutation-tested: it FAILS against the pre-fix engine and passes against the fixed one.

### Fixed — EMA9+VWAP red-team pass: two defects introduced by the previous parity commit

A from-scratch adversarial audit found that the backtest feature-parity work in `3e12da1` shipped two real bugs. Both are in the backtest / a disabled path — Paper and Live were never affected — but they made the backtest untrustworthy the moment the candle trail or a stop was enabled. Paper signals are bit-identical (0 diffs over 1,389 evaluations) and a default backtest is unchanged (20 trades / ₹2,735 before and after).

- **The backtest candle trail fired on the candle that set it.** The trail level was computed from a window that INCLUDES the current candle and then tested against that same candle's low/high, which is true by construction whenever the bar makes the N-bar extreme. Result: `Trail SL hit` took **20 of 20** exits, three of them on `candlesHeld=1`, hijacking every other exit rule. Paper sets the stop at candle close and enforces it on the FOLLOWING bar's ticks, so the setting bar can never trigger it. The engine now **checks the carried-in level first, then re-arms from the closed window** — trail exits fell to 16/20 and none occur on the setting candle.
- **Protective-stop exits booked the candle close instead of the stop level.** `_closeTrade` always used `candle.close`, so a 25-pt stop on a bar that ran 60 pts through it booked −60 in the backtest and −25 in paper. `_closeTrade` now takes an optional `exitLevel` and the points stop, option stop and trail pass theirs — mirroring paper's `simulateSell(_capLvl, …)` / `simulateSell(updatedSL, …)`. Verified: every 25-pt stop exit now books exactly −25.00 spot points.
- **Intra-candle entries were gated on a FUTURE timestamp.** The forming bar was passed to the candle-close window helper, so the 10:25–10:30 bar reported the window open at 10:26 — four minutes early. New `isEntryWindowOpenNow()` uses the replay-safe `simNow()` clock, which is the correct clock for a fill that happens now. (Disabled path: `EMA9VWAP_INTRACANDLE_ENTRY=false`.)
- **Live `/start` armed the harness before checking the paper engine was free.** It installed, then discovered paper was already running and uninstalled — leaving real orders enabled for the duration of that call. It now returns **409** before arming anything.
- **`/simulate/start` bypassed the harness release** (it sets `ptState.running` directly). Safe only because `simulateBuy` skips `notifyEntry` in sim mode; it now releases the harness too, so safety no longer rests on one flag.

### Added — `npm test`: EMA9+VWAP regression suite

[tests/ema9vwap.regression.js](tests/ema9vwap.regression.js) — 16 assertions, no framework, non-zero exit on failure. Runs against REAL cached NIFTY 5-min candles (which carry genuine per-bar volume — the exact input that broke VWAP parity) and falls back to a deterministic synthetic series. Every assertion guards a defect that was actually found: VWAP identical with/without volume, session anchor resets, band multiplier linear, no cross on the first candle of a session, entry window gates on candle CLOSE, malformed `HH:MM` falls back rather than opening at midnight, defaults produce no stop exits, the trail does not fire on its own candle, stops book the stop level, EMA9 matches `technicalindicators`, entries are true band crosses, and entry/exit are mutually exclusive.

### Fixed — EMA9+VWAP: harness safety, VWAP parity and full Paper/Live/Backtest alignment

Twelve implementation defects from an independent adversarial review. No trading rule changed: EMA, band multiplier, entry/exit rules, reversal logic, confirmation behaviour, position sizing, daily limits, strike and expiry selection are all untouched. Verified with a regression suite over 20 real April-2026 sessions.

- **C1 — a live harness could outlive its session and make PAPER place real orders.** The harness fires on the `EMA9VWAP-PAPER` notify tag and was removed only by `GET /ema9vwap-live/stop`; auto-stop, EOD, paper `/stop`, `stopSession()` and SIGTERM all left it armed in the same PM2 process. Every exit path now releases it, `uninstall` is idempotent, `install` replaces a stale harness instead of throwing, and paper `/start` releases any attached harness as its **first statement** (before the token check and every other early return) unless invoked by the live route with `_viaHarness=1`. `gracefulShutdown` drops all harnesses as a backstop. Five lifecycle assertions pass.
- **C2 — Paper and Backtest computed different VWAPs.** Fyers *history* returns per-bar index volume (e.g. 41,002,444 on a 5-min bar) but the live *tick* feed does not, so the volume-aware branch made the Backtest volume-weighted and Paper equal-weighted: up to **80.49 pts** of band difference and a different signal/exit flag on **41 of 640** evaluations. `computeVwapBands()` is now unconditionally **equal-weighted HLC3 (TWAP)** — the only weighting all four engines can compute identically, and the one every recorded paper trade used. Now 0.00 pts / 0 flips. Trade-off documented: TradingView's VWAP is volume-weighted, so absolute band values differ from a TV overlay; matching TV would require per-bar volume on the live path, which the feed does not provide.
- **H1 — `EMA9VWAP_RESOLUTION`** (blank = inherit `TRADE_RESOLUTION`). EMA9+VWAP read the global key that Settings labels as *EMA_RSI_ST's* timeframe, so changing EMA_RSI_ST to 15-min silently converted this strategy to 15-min **and** flipped its 3-loss breaker from a 20-min pause to a whole-day kill.
- **H2/H3 — entry window is now evaluated from the candle timestamp**, via one shared `strategy.isEntryWindowOpen()`. Paper used wall-clock behind a 60-second cache (non-deterministic at the boundary); the Backtest gated on the candle's *start*, shifting its window one bar in both directions. The cache is gone and a signal is in-window when its candle **closes** inside the range — identical in live, replay and backtest.
- **H4 — Backtest feature parity.** It now implements the optional stops it silently ignored: `EMA9VWAP_STOP_LOSS_PTS`, `_OPT_STOP_PCT` (approximated as an equivalent spot move), `_CANDLE_TRAIL_ENABLED/_BARS`, `_NEG_CANDLE_LIMIT`, `_SL_MODE=candle`, plus `TRADE_EXPIRY_DAY_ONLY` (resolved once per date via `nseHolidays.isExpiryDate`). All default OFF, so a default run is unchanged; each was verified to actually fire when enabled.
- **M1 — option-poll ownership race.** `_optionPollTick` verified only "is there a position", so a reply landing after a same-candle flip published the PREVIOUS contract's premium and the next entry adopted it as its entry price. Now checks `ptState.optionSymbol === symbol` before publishing, matching `emaRsiStPaper`.
- **M2 — stale premium refused.** `fetchOptionLtp` accepted `close_price` / `prev_close_price` — yesterday's close — as an option premium. Those are now rejected with a throttled warning; `optionEntryLtp` stays null and P&L falls to the self-labelling `spot proxy` mode.
- **M3 — Settings now tell the truth.** `EMA9VWAP_ENTRY_START/_END` were module-load `const`s badged "Session restart"; they are re-read in `_refreshConfig()` so stop + start really applies them. Keys read live per candle are classified INSTANT.
- **M4 — same-candle re-entry parity.** Paper `return`s after a reversal/EOD exit but falls through after a signal exit (the opposite-side cooldown is the guard); the Backtest blocked re-entry after *every* exit, diverging when `EMA9VWAP_OPPOSITE_SIDE_COOLDOWN_ENABLED=false`. Both now distinguish the two cases.
- **M5 — 12 keys that were live in code but absent from Settings** (and therefore absent from the per-day settings snapshot, so a day's JSONL could not prove its own config) are now exposed with blank/current defaults: `RESOLUTION`, `SL_PAUSE_CANDLES`, `OPPOSITE_SIDE_COOLDOWN_ENABLED/_CANDLES`, `MAX_CONSEC_LOSSES`, `NEG_CANDLE_LIMIT`, `CANDLE_TRAIL_ENABLED/_BARS`, `SL_MODE`, `STRENGTH_FILTER`, `STRONG_MIN_SIGMA`, `OPTION_EXPIRY_TYPE`.
- **M6 — backtest premium model limits documented, not papered over.** No historical option chain exists for this system, so flat ₹200 entry premium, constant δ0.55, linear theta, no IV/gamma, and a spot-equivalent option stop are all stated in the engine header and README. Backtest ₹ P&L is ordinal only.
- Also: malformed `HH:MM` config falls back to the documented default instead of collapsing to midnight; `_gradeStrength` grades an unmeasurable (σ=0) break WEAK instead of STRONG.

### Fixed — EMA9+VWAP implementation cleanup, round 2 (no strategy logic changed)

- **VIX mode aliasing** — [src/services/vixFilter.js](src/services/vixFilter.js). `checkLiveVix("STRONG")` was called with no mode and `getVixEnabled()` had no `ema9vwap` branch, so EMA9+VWAP silently ran on EMA_RSI_ST's VIX toggle and threshold. Added `EMA9VWAP_VIX_ENABLED` / `_VIX_MAX_ENTRY` / `_VIX_STRONG_ONLY`. The enable flag is deliberately **tri-state**: blank inherits the global `VIX_FILTER_ENABLED` (on unless explicitly false), which is the historical behaviour — a plain default-off toggle would have silently disabled a gate that is live today. Added `ema9vwap` to `anyVixEnabled()` (without it, enabling only EMA9+VWAP's VIX would make `fetchLiveVix()` return null and fail-closed would block every entry). All paper call sites, the status page and the log line now use the per-mode reader.
- **Backtest parity** — [src/services/ema9vwapBacktestEngine.js](src/services/ema9vwapBacktestEngine.js) now resolves VIX with `{ mode: "ema9vwap" }` instead of `"ema_rsi_st"`. Paper, Live (harness) and Backtest share one strategy module, so the volume-weighting and day-boundary fixes were already common to all three.
- **Blocked-signal audit trail** — [src/routes/ema9vwapPaper.js](src/routes/ema9vwapPaper.js) + [src/utils/skipLogger.js](src/utils/skipLogger.js). A real cross rejected by the entry window, a circuit breaker or a cooldown previously wrote to neither the trade log nor the skip log. Each gate now writes one skip row at its own decision point (`entry_window`, `daily_loss`, `portfolio_cap`, `consec_loss_pause`, `chop_guard`, `max_daily_trades`, `sl_cooldown`, `opposite_cooldown`, `expiry_day_only`, `entry_pending`), so exactly one row is produced per blocked signal, attributed to the gate that fired first. Logging only — the entry condition is character-identical.
- **Docs corrected to match the code** — removed `"opposite signal"` from the `/start` banner and the `"Opposite Signal"` + `"50% Rule"` buckets from the day report (no such exits exist; the 50% rule is disabled in code), added a `Signal Exit (band re-entry)` bucket that previously fell into "Other", and made the banner and the status tiles print the **resolved** per-strategy caps and VIX/OI state instead of the global `MAX_DAILY_*` / `VIX_FILTER_ENABLED` keys the engine does not read (the banner also defaulted MaxTrades to a stale `6`).

### Fixed — EMA9+VWAP implementation defects (no strategy logic changed)

Four defects where the code did not faithfully execute the documented EMA9+VWAP strategy. Entry rules, exit rules, EMA period, band multiplier, timings, sizing and expiry selection are all untouched.

- **Frozen VWAP band (root cause found + fixed)** — [src/strategies/ema9_vwap.js](src/strategies/ema9_vwap.js) `computeVwapBands()`. `anyVol` flipped the volume-weighted branch on if *any* in-session candle carried volume, and that branch then ignored every zero-volume candle. On a mixed session (warm-up candles from Fyers history carry volume, live tick-built candles do not) VWAP/upper/lower/σ froze at the volume-bearing subset **for the whole day** while EMA9 kept moving. Observed live on **2026-07-16**: band pinned at `24144.08 / ±6.28` from 09:35 to 15:30 while spot ranged 24058–24173; two trades were taken against it. Volume weighting is now an all-or-nothing decision for the series (`volCount === count`), so a mixed session falls back to the documented equal-weight TWAP instead of silently dropping candles. All-zero-volume (the real NIFTY index case) and all-volume sessions are bit-identical to before.
- **Day-boundary previous band** — [src/strategies/ema9_vwap.js](src/strategies/ema9_vwap.js) `getSignal()`. `computeVwapBands(candles.slice(0,-1))` anchors on the IST day of the last candle it receives, so on the first candle of a new session the "previous" band was **yesterday's completed band** — which manufactured phantom crosses. The previous band is now required to come from the same session; with no same-day predecessor the signal reports warming-up. Verified over 4 synthetic sessions: 3 of 289 evaluations changed, all at 09:15, two of which were phantom `BUY_PE` signals under the old code.
- **OI gate was unreachable** — [src/services/oiFilter.js](src/services/oiFilter.js) `getOiEnabled()` had no `ema9vwap` branch, so the mode string the paper engine passes fell through to `EMA_RSI_ST_OI_ENABLED` and the gate could never be enabled for this strategy (810 logged skips contained zero OI blocks). Added the `EMA9VWAP_OI_ENABLED` branch (default **off** → no behaviour change), included it in `anyOiEnabled()`, exposed it in the Settings UI and README, and documented that any unknown mode string silently aliases to EMA_RSI_ST.
- **Spot substituted as option premium** — [src/routes/ema9vwapPaper.js](src/routes/ema9vwapPaper.js) `startOptionPolling()`. If the option quote had not arrived 10 s after entry, the NIFTY **spot** level was written into `optionEntryLtp`. An exit would then book roughly `(exitPremium − 24000) × 65` ≈ a multi-lakh phantom loss and latch the daily-loss kill switch. The watchdog now only warns; `optionEntryLtp` stays null so `simulateSell()` uses the pre-existing, self-labelling `spot proxy (option LTP unavailable)` P&L mode. Also removes a latent cross-position bug where a stale 10 s timer could write into a *newer* position. EMA9+VWAP Live wraps this same paper engine, so live is covered by construction.

### Added — Day-based replay: replay ANY strategy on ANY recorded date (no session marker needed)

Closes the gap where replay was driven by per-strategy session markers, so a strategy that didn't run on a day — or one **created later** — could not replay that day even though the day's shared ticks were on disk. Paired with the day-wide option-chain recorder, recorded days are now fully strategy-independent: record once, replay with any strategy, now or in the future.

- **[src/services/tickReplay.js](src/services/tickReplay.js)** — `loadSessionData` grows a `synthesize` mode: when set it builds a **synthetic full-day session** (window = the day's spot-tick span) instead of requiring a `sessions.jsonl` start marker. `replaySession({ synthesize:true })` forces current-settings mode (no recorded snapshot exists), pins the option expiry from the recorded Market Context Snapshot, and passes `syntheticWarmup` to the harness so the strategy's own `/start` fetches real warm-up candles from the history API (the replay-day option/vix/oi/spot ticks still come purely from disk). The marker-based path is unchanged.
- **[src/routes/replay.js](src/routes/replay.js)** — new `POST /replay/run-day` ({date, mode}) and a **"📅 Day replay — any strategy"** card: pick a date + strategy, replay the whole day, no session required. A new strategy becomes replayable on every recorded day the moment it's added to `STRATEGY_OPTIONS` + `MODE_TO_MODULE`. Always recomputes (a synthetic session has no snapshot to key the cache with).

### Added — Day-wide option-chain recorder (SNAPSHOT replay reproducible for any strategy)

Fixes the root cause of "same snapshot settings, different replay P&L". The per-strategy recorder only captured the single option symbol a *running* strategy polled (its position/entry candidate), plus VIX/OI only while that strategy's filter was on. So when a replay decision diverged even one candle it wanted a *different* strike with no recorded LTP → it fell back to a spot proxy → replay drifted from live. A brand-new strategy had no option data at all for old days.

- **[src/utils/optionChainRecorder.js](src/utils/optionChainRecorder.js)** (new) — a pure-observer loop that, every few seconds during market hours, proactively polls the ATM±N CE/PE chain + INDIA VIX + current-month NIFTY futures OI and appends to the **same** per-day tick streams the replay already reads (`options.jsonl` / `vix.jsonl` / `oi.jsonl` via `tickRecorder`). Strategy-independent and date-based: the same ticks serve every strategy, present or future. Rides the existing socket fan-out for spot (never opens a second socket); one in-flight poll at a time; Fyers per-call symbol cap respected; failure logging throttled. Expiry is pinned once/day from the Market Context Snapshot so recorded strikes line up exactly with what replay resolves.
- **Wiring**: started from [src/app.js](src/app.js) after the tick-recorder prune block. No replay-reader change needed — purely additive density + coverage.
- **Knobs** (all in the Settings UI + README env table): `OPTION_CHAIN_RECORDER_ENABLED` (default `true`), `OPTION_CHAIN_RECORD_INTERVAL_SEC` (default `5`, 2–60), `OPTION_CHAIN_RECORD_STRIKES` (default `5`, ATM±N, 1–15). Reuses the master `TICK_RECORDER_ENABLED` switch and retention/prune.

### Added — Replay "Delete all" (full wipe)

- **[src/routes/replay.js](src/routes/replay.js)** — new **🗑 Delete all** button next to *Download all* on the Replay page, backed by `POST /replay/delete-all` → `tickRecorder.deleteRecordingsInRange({})`. Permanently removes every recorded day folder (raw ticks + session markers + market context) behind a strong confirm. Bulk counterpart to the existing per-row (marker-only) delete.

### Added — PA trend filter (course rule #1: trade breakouts with the trend)

Optional regime gate for Price Action, distilled from the price-action course notes ([data/pa-course-transcript.txt](data/pa-course-transcript.txt)). The course's single most-repeated rule is *never trade a breakout against the trend*. Our PA fired all four patterns in any regime; this adds a default-**OFF** filter so it can be replay-validated before going live.

- **[src/strategies/price_action.js](src/strategies/price_action.js)** — new `_trendBias()` (EMA-vs-close on PA candles, `technicalindicators` EMA per repo convention) plus range-extreme checks. When `PA_TREND_FILTER_ENABLED=true`: the *continuation* patterns (Ascending/Descending Triangle) only fire when the EMA bias agrees (Asc→UP, Desc→DOWN); the *reversal* patterns (Double Top/Bottom) only fire when their twin level is the actual high/low of the recent swing range (not a mid-range wiggle). Blocked setups log a structured `Trend filter: …` skip reason. Filter OFF = byte-identical behaviour to before (verified).
- **Knobs**: `PA_TREND_FILTER_ENABLED` (default `false`), `PA_TREND_EMA_PERIOD` (default `20`), `PA_TREND_FLAT_BAND` (default `0`) — all exposed in the Settings UI ([src/routes/settings.js](src/routes/settings.js)) and README env table.
- Shared `getSignal` means paper/backtest/live inherit the filter identically; no per-mode drift.

### Added — immutable Market Context Snapshot (fixes replay-vs-paper expiry mismatch)

Replay of an **old** day used to re-resolve the option expiry from *today* — the two resolution paths (`instrument.getNearestThursdayExpiry()`'s `new Date()` and the live Option-Chain REST) are not patched by the replay clock, and the per-session snapshot only stored the *override* env key (blank on auto-detect days). So an auto-detected day replayed on today's expiry → wrong strikes/symbols → `no_data` → spot-proxy P&L that never matched paper. Now the market's own facts are recorded once and pinned on replay.

- **`market.jsonl` — one immutable, strategy-independent snapshot per IST day** ([src/services/marketContext.js](src/services/marketContext.js), [src/utils/tickRecorder.js](src/utils/tickRecorder.js) `recordMarketContext`, [src/config/instrument.js](src/config/instrument.js) `getMarketContext`): the first live spot tick freezes weekly + monthly expiry (as `YYYY-MM-DD`), strike interval, lot size, instrument/exchange/broker meta, and schema/recorder versions. Captured on the shared socket fan-out ([src/utils/socketManager.js](src/utils/socketManager.js)) so it's independent of which/how-many strategies run — a day recorded today is replayable by a strategy that doesn't exist yet. Idempotent (once/day), fire-and-forget, no hot-path cost; no-op when `TICK_RECORDER_ENABLED=false`.
- **Replay pins expiry from the recording for BOTH toggles** ([src/services/tickReplay.js](src/services/tickReplay.js) `_resolveReplayExpiryEnv`): expiry is a market fact read from the recorded session snapshot — current `process.env` is ignored for expiry, so a standing override in today's Settings can't leak into an old-day replay. A recorded explicit override (e.g. EMA_RSI_ST deliberately trading next-week to dodge 0DTE) is honored with its recorded weekly/monthly type; the auto-detect path pins the recorded **nearest** expiry from the Market Context Snapshot (mirroring instrument.js, which ignores `OPTION_EXPIRY_TYPE` unless an override date is set — so a recorded `type=monthly` with no override still replays the weekly nearest paper actually traded). The mode→prefix map lists only strategies that pass a `mode` arg (EMA_RSI_ST/ORB/EMA9VWAP/TREND_PB); bb_rsi/pa read the common key only, so their inert per-mode keys aren't promoted. **Current-settings** mode overrides only non-expiry strategy config (entry/exit/filters/risk/sizing). Replay-result cache bumped to **v8**.
- **Backward-compatible**: recordings without `market.jsonl` log a warning and fall back to the prior per-session expiry pin — nothing crashes.
- *Note*: capturing the **full option-chain snapshot** (per-strike bid/ask/volume/OI/tokens) and unifying option/VIX/OI recording into the same strategy-independent recorder is the next phase (enables future strategies to pick strikes the recorded strategies never held).

### Fixed — deep 5-agent re-audit: blocker/HIGH harness, lifecycle, persistence gaps

Second adversarial pass over the live/harness and crash-recovery paths after the first audit. All fixes are on the real-order / restart-safety surfaces (still gated behind `LIVE_HARNESS_DRY_RUN=false` where they touch orders).

- **Harness reconcile no longer trusts an unreadable book** (BLOCKER): `broker.getPositions()` returns an empty `{}`/`[]` on an expired daily token *or* a swallowed API error — the old code read that as "flat", deleted the tracked record, and skipped a real exit → orphaned live long with no alert. `_heldQty` now returns `null` ("can't verify") on an empty/unauthenticated book and `0` (flat) only when a **non-empty** book lacks our symbol (logs the symbol on a miss for format-drift diagnosis).
- **Partial-fill short guard**: an exit SELL is now capped at the broker's actual held qty, so a partial BUY fill can't leave a residual short.
- **Same-candle CE→PE flip**: entry dedupe now keys on symbol (with identity-guarded record deletes) so a flip's opposite leg isn't dropped as a "duplicate"; a timed-out/errored BUY marks the mode UNCONFIRMED and blocks re-entry (no double real long), and an orphaned exchange SL-M is cancelled on the broker-flat branch too.
- **Daily-loss kill-switch re-arm on restart** (HIGH): the reconstruct compared `new Date(istNow())` = *Invalid Date* → never matched today → the switch silently never re-armed. Now parses both `DD/MM/YYYY` and ISO session dates.
- **EMA_RSI_ST `/stop` + SIGTERM**: `/stop` used the old 2-mode socket guard (ignored ORB/PA/Trend_PB) and had no `stopSession` export → it could kill the shared Fyers socket under another strategy's live position, and a live Zerodha position wasn't squared off on SIGTERM. Both fixed; ORB/Trend_PB now clear their own mode **before** the `isAnyActive()` check so the socket isn't leaked when they're the last user. Shutdown drain scales off `HARNESS_BROKER_TIMEOUT_MS` so `process.exit` can't abandon an in-flight square-off SELL.
- **Manual entries routed through the lot clamp**: the two manual-entry buttons (emaRsiStPaper / ema9vwapPaper) computed qty raw from `LOT_MULTIPLIER`, bypassing the `MAX_LOT_MULTIPLIER` clamp (a fat-finger `LOT_MULTIPLIER=50` would place 3250 qty on the manual path while automated entries clamped to 650). Both now call `getLotQty()`; a non-numeric `MAX_LOT_MULTIPLIER` now falls back to `10` instead of `NaN`-disabling the clamp.
- **Atomic live-session write**: `saveLiveSession` wrote `_live_trades.json` with a raw `writeFileSync` — a crash mid-write truncated it → `loadLiveData()` reads an empty book → the daily-loss kill-switch resets to ₹0 and prior live history is overwritten on the next save. Now tmp+rename like every other persisted file.
- **Boot reconcile retains snapshots on an unreadable book**: an empty broker book (both brokers return `[]` on a swallowed API error) no longer clears the crash snapshots + logs an all-clear; snapshots are cleared only when the book is provably readable, otherwise retained with a re-check warning. The retain guard is gated on `_liveActive` (harness not dry-run, or a native `*_LIVE_ENABLED`) so paper-only boots still clear stale snapshots silently instead of firing a spurious "retaining snapshots" Telegram on every boot. `notify` now `.catch`es the async exit hook so it can't escape to the global `unhandledRejection` handler.
- **Docs**: [README.md](README.md) + [CLAUDE.md](CLAUDE.md) updated — crash-recovery now covers **all six** engines (EMA_RSI_ST/BB_RSI/PA/EMA9_VWAP/ORB/Trend_PB), each with an `.active_*_position.json` snapshot, replacing the stale "ORB has no crash-recovery" note.

### Added — risk, persistence & signal-quality features (all default OFF)

- **Portfolio-wide daily loss cap** (`PORTFOLIO_MAX_DAILY_LOSS`, default `0`/off — [src/utils/portfolioRisk.js](src/utils/portfolioRisk.js)): each strategy previously capped only its own daily loss, so every strategy hitting its cap the same day could lose far more in aggregate. This sums today's realized P&L across **all six** paper modes (via the canonical per-day JSONL logs) and, once the combined loss reaches the cap, blocks new entries in every strategy for the rest of the day. Wired into all 6 paper routes' entry gates (candle-close **and** intra-tick paths). Fail-safe: the gate only ever **blocks** entries, never places/alters an order, and fails **open** on any read error.
- **Crash-recovery snapshots for ORB, Trend_PB, EMA9_VWAP** ([src/utils/positionPersist.js](src/utils/positionPersist.js)): ORB/Trend_PB had no active-position persistence and EMA9_VWAP's helpers existed but were never called — a crash mid-trade left an untracked position. Added the save/load/clear helpers (mirroring BB_RSI/PA), wired save-on-open + clear-on-close in all three paper routes (canonical; harness-live mirrors it), and boot reconcile in [app.js](src/app.js) (orphan Telegram alert + clear-on-broker-flat). All six engines now survive a restart with an open position.
- **EMA_RSI_ST optional breakeven stop** (`EMA_RSI_ST_BREAKEVEN_ENABLED` / `EMA_RSI_ST_BREAKEVEN_PTS`, default off): the code long documented a "+25pt breakeven" that was never implemented. Now real — once a trade is `BREAKEVEN_PTS` in profit (spot, at candle close) the stop is raised to entry (tighten-only floor) so a winner can't flip to a loss. Implemented identically in paper (canonical), backtest, and live (live also persists the snapshot and modifies the exchange SL-M).
- **EMA9+VWAP real signal-strength grading + optional WEAK filter** (`EMA9VWAP_STRENGTH_FILTER`, default off): `signalStrength` was a hardcoded `"STRONG"`. `getSignal` now grades each cross by how far EMA9 broke past the band edge in σ units (STRONG if ≥ 0.25σ, else WEAK); with the filter on, WEAK crosses are suppressed. Graded inside the shared strategy so paper / live-harness / backtest behave identically; the paper route now records the real strength.
- **Optional exchange-resident disaster stop for harness-live** (`HARNESS_EXCHANGE_SL_ENABLED` / `HARNESS_SL_PCT`, default OFF — [src/services/liveHarness.js](src/services/liveHarness.js)): a harness-live position had no exchange-side protection — a crash mid-trade left it naked until recovery. This rests an SL-M at the exchange as a backstop (the in-process per-tick stop stays primary). Because paper's stop is a spot level (not an option trigger), it uses a % of the entry premium. The resting SL-M is cancelled **before** any normal square-off so it can't fire on the position being sold (no naked short). Places real orders — validate on a dry-run session before enabling.

### Fixed — multi-agent audit follow-ups (safety, lifecycle, backtest realism)

- **Harness live-order path hardened** (gated behind `LIVE_HARNESS_DRY_RUN=false`): reconcile against `broker.getPositions()` before any square-off SELL so a position already closed out-of-band (post-accept reject, MIS auto-square ~15:20, exchange SL-M fired, manual close) is never short-sold; await in-flight BUYs before an exit; clear the tracked position only after a confirmed SELL; dedupe double BUYs/SELLs; timeout every broker call (`HARNESS_BROKER_TIMEOUT_MS`).
- **Shared-socket teardown**: stopping BB_RSI/PA/EMA_RSI_ST no longer tears the one Fyers socket out from under a live ORB/PA/Trend_PB position (guards now use `sharedSocketState.isAnyActive()`).
- **Graceful shutdown** now squares off EMA_RSI_ST and EMA9VWAP too (their paper routes export `stopSession()`), so a deploy/SIGTERM can't orphan a harness-live position.
- **Backtest realism**: VIX look-ahead removed (backtests now use the prior day's VIX close, not the current day's close); gap-through stop fills added to bb_rsi/pa/orb/trend_pb; bb_rsi exit-side slippage applied; EMA9_VWAP frictionless default aligned to 1.5pt.
- **Risk/perf**: portfolio-cap read memoized (no per-tick disk reads when armed); `MAX_LOT_MULTIPLIER` clamps a fat-finger lot multiplier; boot warning for dead `SWING_*`/`SCALP_*` env keys.

### New: Consolidation Report — daily report reached from the Edge Analytics page

A **day-by-day** consolidated report of every recorded trade (paper + live), mirroring the Telegram "CONSOLIDATED DAY REPORT" layout — the "till-now" report the user asked for. Reached via a **button on the Edge Analytics page**, not a separate sidebar item.

- **New route** [src/routes/consolidationReport.js](src/routes/consolidationReport.js) — read-only, loads the same per-strategy session files as `/consolidation` + `/live-consolidation`, embeds the flattened trade array, and aggregates **per trading day** client-side.
- **Daily table** (row per day, newest first): per-strategy trades + P&L columns (only strategies that traded in range are shown), then **Total / Wins / Losses / Win rate / Net P&L** and a 🟢 PROFIT / 🔴 LOSS result per day, with a totals footer — verified to reproduce the Telegram day-report numbers exactly. Plus a summary card band (total trades, W, L, win rate, net P&L, avg/day).
- **Filters**: Book (Paper / Live / **Both**) and a Range preset — **This week · Last week · This month · Last month · Last 7 / 30 days · This FY · All time · Custom (from–to)**.
- **PDF export**: **🖨 Save as PDF** → `window.print()` through a dedicated `@media print` stylesheet (app chrome / toolbar / buttons hidden, white A4-landscape page, repeated table header, page-break-safe rows). Browser-native print-to-PDF — no external library.
- **Entry point + wiring**: a `📑 Consolidation Report` button on the Edge Analytics toolbar ([src/routes/edgeAnalytics.js](src/routes/edgeAnalytics.js)), gated by the **Settings toggle** `UI_SHOW_CONSOLIDATION_REPORT` (default on) in [src/routes/settings.js](src/routes/settings.js); route mounted in [src/app.js](src/app.js). Not added to the sidebar. README route + env-key tables synced.

### Trend Pullback — full-app parity sweep (fix surfaces the earlier wiring missed)

A user-flagged gap (missing Telegram toggles) triggered an exhaustive audit of every per-strategy enumeration vs ORB/EMA9VWAP. Fixes:

- **Telegram: 4 missing toggles added** — `TG_TREND_PB_{STARTED,ENTRY,EXIT,DAYREPORT}` in Settings ([src/routes/settings.js](src/routes/settings.js)). notify.js was already firing these (fail-open), so alerts sent but were un-silenceable from the UI; now they have toggles like every other strategy. No SIGNALS toggle (Trend Pullback, like ORB, emits no signal alerts).
- **"Start All (Harness)" now starts Trend Pullback** — `HARNESS_ENDPOINTS` omitted `/trend-pb-live/start`, so the dashboard top-bar harness button silently skipped it ([src/app.js](src/app.js)). Also: dashboard **IDLE badge** condition, Start-All tooltip + confirm/toast mode labels (now list EMA9+VWAP + TREND PB), and `_prettyEndpoint` (widened regex + `trend-pb` label) for the Start-All failure modal.
- **Deterministic replay** — `TREND_PB_OPTION_EXPIRY_OVERRIDE`/`_TYPE` added to tickReplay's expiry-pin list so a Trend Pullback session replays against its recorded expiry ([src/services/tickReplay.js](src/services/tickReplay.js)).
- **Logs page** totals footer (`_filesTotals`/`_skipsTotals`) seeds `trend_pb` ([src/routes/tradeLogs.js](src/routes/tradeLogs.js)); notify.js JSDoc key enumerations updated.
- **Docs**: new [documents/Trend_Pullback_Strategy_Guide.html](documents/Trend_Pullback_Strategy_Guide.html) + GUIDE_STATUS entry ([src/routes/docs.js](src/routes/docs.js)) — appears in the Documents tab with a live "as-per-settings" config panel, like every other strategy.
- **README** synced: dedicated `### Trend Pullback Mode` env table, `### Trend Pullback` routes subsection, OI + LIVE_DRY_RUN rows, completed the MODE_ENABLED / UI_SHOW / Telegram brace-lists (also filling in EMA9VWAP where it was missing), Fyers investment-pool note, and the JSONL audit-log entry.
- Still deferred (unchanged): positionPersist crash-recovery of an open live position (matches ORB).

### Trend Pullback — Phase C: live via paper-wrapping harness (triple-gated dry-run)

- **New live route** `/trend-pb-live` ([src/routes/trendPbLiveHarness.js](src/routes/trendPbLiveHarness.js)): runs Live by wrapping the Paper engine with the shared `liveHarness` (like EMA9VWAP) — triggers `/trend-pb-paper/start` programmatically and places real **Fyers** orders as paper's notifyEntry/notifyExit fire. LIVE = PAPER by construction (no separate live decision path).
- **Triple-gated to dry-run** — real orders require `TREND_PB_LIVE_ENABLED=true` AND `LIVE_HARNESS_DRY_RUN=false` AND `TREND_PB_LIVE_DRY_RUN` not-true, plus an authenticated Fyers session. By default nothing places a real order (verified: `isDryRun("TREND_PB")` returns true out of the box). Status page carries the standard dry-run/live warning banners + the paper chart (VWAP + EMA20 overlay) + harness event log.
- Wired: mounted in app.js; `/trend-pb-live/status/data` in OPEN_PATHS (Phase A); sidebar Live item now points at the harness page and defaults on (`UI_SHOW_TREND_PB_LIVE=true`); the Real-Time monitor's LIVE column now resolves. The unused separate `UI_SHOW_TREND_PB_LIVE_HARNESS` toggle was removed (harness-only pattern).
- **Deferred** (documented): positionPersist crash-recovery of an open live position (matches ORB's current state) and liveConsolidation (harness strategies don't write a `_live_trades.json` session file, so EMA9VWAP is absent there too — live trades surface via the `trend_pb-live` JSONL log + harness events).

### Trend Pullback — Phase B: backtest with walk-forward + dumb-baseline + cost-modeling

- **New backtest route** `/trend-pb-backtest` ([src/routes/trendPbBacktest.js](src/routes/trendPbBacktest.js)): replays 5-min candles through the same `getSignal` and **re-implements the paper SPOT exits** (paper is canonical; it deliberately does NOT use the shared EMA_RSI_ST-flavored backtestEngine). Background-job + progress-poll UI mirroring the ORB backtest. Uses `computeBacktestStats` so profit factor / expectancy / Sharpe / equity-curve max-drawdown come for free.
- **Realistic costs**: option P&L is δ+θ simulated seeded slightly-ITM (`TREND_PB_BT_SEED_PREMIUM=240`) **plus a spread/slippage haircut** `TREND_PB_BT_SLIPPAGE_PTS=1.5`pt each way, with `getCharges` on top. Option-buying backtests without modeled spread look great and lose live — this closes that gap.
- **Dumb baseline**: the same date range is also run with a naive engine (enter in the 15m-trend direction at the entry-window open, identical trail + EOD, **no** pullback/resumption filter). The results page shows the strategy-vs-baseline delta — if the filter doesn't beat the baseline out-of-sample, it's curve-fit noise.
- **Walk-forward** ([src/utils/walkForward.js](src/utils/walkForward.js)): trades are split into rolling ~20-day out-of-sample folds (params are fixed defaults, so every fold is OOS by construction) with a stability verdict and **thin-fold flags** (< 20 trades = noise, not proven edge). Surfaced on the results page + `/all-backtest` panel.
- Wired into `/all-backtest` (new pink TREND PB panel) and the sidebar/Settings (`UI_SHOW_TREND_PB_BACKTEST` now defaults on). Verified end-to-end offline: entry chain, per-candle management (breakeven/trail/EMA-fail/time-stop), EOD, costs on both winners and stop-outs, baseline, and walk-forward folds all execute correctly.

### Trend Pullback — new independent strategy (Phase A: paper + UI)

- **New single-strategy, institutional-grade intraday option-buying engine** ([src/strategies/trend_pb.js](src/strategies/trend_pb.js) + [src/routes/trendPbPaper.js](src/routes/trendPbPaper.js)), fully independent — ORB and every other strategy are untouched. Design was critically reviewed and approved before any code (capital preservation over trade frequency; ≤ ~7 real signal knobs to minimise overfitting; price structure over indicator stacking; exits weighted over entries).
- **Entry** (all must hold): 15-min trend **bias** (higher-high/higher-low swing structure + `EMA20>EMA50` + EMA20 slope + spot vs session VWAP) → **healthy 5-min pullback** back into the `EMA20(5m)` zone without breaking (`TREND_PB_PULLBACK_MAX_ATR=1.5×ATR5` depth cap) → **resumption candle** that closes above `EMA20(5m)` and the prior bar's high with **body ≥ `TREND_PB_BODY_ATR_MULT=0.5×ATR5`**. Body-vs-ATR is the conviction proxy — NIFTY spot has no real volume, so "volume confirmation" was deliberately **not** implemented (would be a fake input to overfit). Window `TREND_PB_ENTRY_START=09:45`→`TREND_PB_ENTRY_END=14:30`; slightly-ITM (`TREND_PB_ITM_STEPS=1`).
- **Exit — all on SPOT** (premium only for the backstop): structural stop at the pullback extreme (clamped `[TREND_PB_STOP_CLAMP_MIN=8, MAX=30]`) → breakeven (`TREND_PB_BREAKEVEN_R=1.0`) → **ATR-chandelier trail** (`TREND_PB_TRAIL_ATR_MULT=2.5×ATR5`, the right-tail engine) → EMA20(5m)-close trend-failure (`TREND_PB_TRAIL_EMA=20`) → time-stop (`TREND_PB_TIME_STOP_CANDLES=6`) → EOD `TREND_PB_FORCED_EXIT=15:15` → premium disaster stop `TREND_PB_PREMIUM_STOP_PCT=35`. **No fixed target, no partial booking** (partials cap the right tail that pays for the losers); fixed lot size (confidence-scaled sizing avoided until OOS-validated).
- **Risk / guards**: `TREND_PB_MAX_DAILY_TRADES=3`, `TREND_PB_MAX_DAILY_LOSS=5000`, `TREND_PB_LOSS_STREAK_SKIP=3`; per-mode VIX gate (`TREND_PB_VIX_ENABLED`, off) + OI-buildup gate (`TREND_PB_OI_ENABLED`, off) + bid-ask spread guard, all reusing existing infra.
- **Reused, not rebuilt**: `charges.js`, `tradeGuards.js`, `vixFilter.js` (new `trend_pb` mode branch), `oiFilter.js` (new branch), `config/instrument.js` (`"TREND_PB"` mode → ITM steps), `tradeLogger.js` + `skipLogger.js` (registered `trend_pb`), `tickRecorder`, `notify`. New route `/trend-pb-paper` (paper canonical) with status/history/chart/reset endpoints, live NIFTY chart with VWAP + EMA20(5m) overlay.
- **Full UI integration** like every other strategy: `TREND_PB_MODE_ENABLED` master toggle + the strategy section + `UI_SHOW_TREND_PB_*` submenu toggles in **Settings**; **sidebar** group (Paper + History; Backtest/Live hidden until Phases B/C); **Real-Time monitor** row (`STRATEGY_DEFS` + pink accent); **dashboard** session tile + start-all + analytics polling; graceful-shutdown square-off. `sharedSocketState` gains `TREND_PB_PAPER`/`TREND_PB_LIVE` mode tracking + `canStart` mutual-exclusion.
- **Phases B/C to follow after paper validation**: dedicated backtest route with **walk-forward** validation, realistic option **costs** (spread/slippage haircut + `charges.js`), and a **dumb-baseline** comparison the filtered strategy must beat out-of-sample; then live via a dry-run-gated harness + `positionPersist` crash-recovery trio.

### ORB — full redesign: trend-day engine V3 (`ORB_ENTRY_V3_ENABLED`, default ON) + slightly-ITM + portfolio breaker

- **Ground-up rebuild aimed at a single objective: capture trend days, eliminate false breakouts — not trade more.** New engine `_getSignalV3` in [src/strategies/orb_breakout.js](src/strategies/orb_breakout.js), shared by backtest + paper + live so all three stay identical. Takes precedence over V2/V1 (both kept behind the flag for rollback). Design was reviewed and approved before implementation; the audit is in the 2026-07-10 session.
- **Slightly-ITM instrument** (`ORB_ITM_STEPS=1`, ~delta 0.6): higher delta tracks the trend move and decays slower in % than ATM — the biggest expectancy lever inside "options." Applied in [instrument.js](src/config/instrument.js) for ORB mode only (CE lower / PE higher strike). Premium band widened to `[ORB_PREMIUM_MIN=120, ORB_PREMIUM_MAX=400]`; backtest seed premium → `ORB_BT_SEED_PREMIUM=240`.
- **Adaptive, ATR-relative gates** (hold across VIX regimes — replaced all fixed-point thresholds):
  - Day filter: OR width in `[ORB_OR_ATR_MIN=0.7, ORB_OR_ATR_MAX=2.5]`×`ATR(15m)`; gap ≤ `ORB_GAP_OR_MULT=3`×OR; **break into fresh ground** (`ORB_PRIORDAY_LEVEL_FILTER=true`, clear prior-day H/L).
  - Breakout: buffer `max(ORB_BUFFER_OR_MULT=0.15×OR, ORB_BUFFER_ATR_MULT=0.3×ATR5, 1pt)`; body ≥ `ORB_BODY_ATR_MULT=0.6×ATR5`; close in the extreme `ORB_CLOSE_POS_PCT=0.25`; on the right side of VWAP.
- **Dropped the V2 EMA20/50 + ADX + RSI + EMA-slope stack** — correlated "is it trending?" filters that delayed entry and clipped the right tail (ORB's entire edge). Confirmation is now just **one candle** (HH/HC beyond the edge + VWAP side).
- **Retest is OPTIONAL and NON-BLOCKING** (`ORB_RETEST_MODE=optional`): primary entry is the confirmation candle (early — this is what keeps trend days). If it hesitates, within `ORB_RETEST_MAX_WAIT=4` candles the engine takes a trend-resume, a retest-and-hold, or a still-trending window-end — a move that never retests **still enters**. A *mandatory* retest measurably hurt expectancy in the 2026-07-09 backtest (10.3% win / PF 0.37 vs 17% / PF 0.60), so it can never veto a trend. Entry window tightened `ORB_ENTRY_END=11:30`.
- **Exit refinements**: adaptive breakeven `max(ORB_BREAKEVEN_PTS=20, ORB_BREAKEVEN_OR_MULT=0.5×OR)`; new **premium disaster stop** `ORB_PREMIUM_STOP_PCT=35` (IV-crush/vega backstop). EMA20 close-trail + strong-opposite-candle + no fixed target unchanged (right-tail friendly).
- **Portfolio risk breaker** ([src/utils/orbRiskState.js](src/utils/orbRiskState.js), persisted `~/trading-data/orb_risk_state.json`, paper/live tracked separately): sit out entries after `ORB_MAX_WEEKLY_LOSS=9000` (ISO week) or `ORB_LOSS_STREAK_SKIP=4` consecutive losing days (one-day cool-off). Gated by `ORB_RISK_THROTTLE_ENABLED`. Pure scoring core unit-tested offline.
- **Fixed paper/live divergence**: the **OI gate is now applied in live** (`orbLive.js`), matching paper (paper is canonical). Live also samples OI each candle and records `oiAtEntry`/`oiRegime`.
- **New Settings knobs** (all wired + README): `ORB_ENTRY_V3_ENABLED`, `ORB_ITM_STEPS`, `ORB_ATR_PERIOD`, `ORB_OR_ATR_MIN/MAX`, `ORB_GAP_OR_MULT`, `ORB_PRIORDAY_LEVEL_FILTER`, `ORB_BODY_ATR_MULT`, `ORB_BUFFER_OR_MULT/ATR_MULT`, `ORB_RETEST_MODE`, `ORB_BREAKEVEN_OR_MULT`, `ORB_PREMIUM_STOP_PCT`, `ORB_RISK_THROTTLE_ENABLED`, `ORB_MAX_WEEKLY_LOSS`, `ORB_LOSS_STREAK_SKIP`. Changed defaults: `ORB_ENTRY_END` 12:00→11:30, `ORB_PREMIUM_MIN/MAX` 100/220→120/400, `ORB_RETEST_MAX_WAIT` 6→4. `ORB_RETEST_ENABLED` is now V2-backtest-only (ignored under V3). Verified with an offline behavioural harness: trend-day early entry, chop-day skip (OR<0.7×ATR15), fake-breakout rejection (invalidation), and retest-and-hold fallback.

### ORB — entry logic redesign: confirmed-breakout engine V2 (`ORB_ENTRY_V2_ENABLED`, default ON)

- **Complete rewrite of the ORB *entry* logic to attack the root cause of the 717-trade / 17%-win backtest: poor entry quality, not poor exits.** The new engine ([src/strategies/orb_breakout.js](src/strategies/orb_breakout.js) `getSignal`) is shared by backtest **and** paper **and** live, so all three stay identical. Exits (breakeven → EMA trend-trail → strong-opposite → per-trade cap → 15:15) are unchanged. Ordered gates:
  1. **Frozen OR** 09:15–09:30, never recomputed (STEP 1).
  2. **Range band** `ORB_MIN_RANGE_PTS=30`…`ORB_MAX_RANGE_PTS=80` (was 25/100) — skip too-tight (noise) and too-wide (open already ran) days (STEP 2).
  3. **Buffer** = `max(ORB_BREAKOUT_BUFFER_MIN=10, ORB_BREAKOUT_BUFFER_PCT=0.20×range)` (was 8/0.15); the **first** close to clear it is the *one committed breakout* of the day (STEP 3).
  4. **Breakout-candle quality**: green/red, body ≥ `ORB_MIN_BODY=15`pt **and** ≥ `ORB_BODY_PCT_MIN=0.60` of the candle, breakout-side wick ≤ `ORB_WICK_PCT_MAX=0.25`, close in the top/bottom `ORB_CLOSE_POS_PCT=0.20`, close beyond VWAP, EMA20 slope in-trend, RSI `>55`(CE)/`<45`(PE) (STEP 4).
  5. **Next-candle confirmation** (`ORB_CONFIRM_ENABLED=true`) — **does not buy the breakout candle**; enters only if the *next* candle holds beyond the edge with a higher-high+higher-close (CE) / lower-low+lower-close (PE). The core false-breakout filter (STEP 5).
  6. **Trend regime**: EMA`ORB_TREND_EMA_FAST=20` vs EMA`ORB_TREND_EMA_SLOW=50` + ADX(`ORB_ADX_PERIOD=14`) `> ORB_ADX_MIN=20` (STEP 6).
  7. **Gap gate** `ORB_MAX_GAP_PTS=80` — skip news/overnight-shock days (STEP 7).
  8. **Option filter**: ATM, premium `[ORB_PREMIUM_MIN=100, ORB_PREMIUM_MAX=220]` (was 80/250), and a new bid-ask **spread gate** `ORB_MAX_SPREAD_PTS=2` now wired into paper + live (fails open with no depth) (STEP 8).
  9. **One committed breakout/day** — a failed confirmation does not trigger a second attempt (STEP 9).
- **Enters on the confirmation candle's close**; the route's initial hard SL is that candle's low (CE) / high (PE). Indicators are seeded from a multi-day preload — the **backtest now feeds `getSignal` a trailing `ORB_SIG_WINDOW=260`-bar multi-day window** (previously a single day, which couldn't seed a 50-EMA/ADX), with OR + VWAP still day-scoped so prior days never leak into today's range.
- **`ORB_ENTRY_V2_ENABLED=false`** falls back to the legacy immediate-entry engine (V1, unchanged) to A/B against the pre-redesign baseline in the backtest. 16 new Settings knobs + README updated. Verified with an offline behavioural harness (confirmation gating, first-breakout-only, one-trade/day, multi-day EMA/ADX seeding).

### ORB backtest — experimental retest-entry gate (`ORB_RETEST_ENABLED`, default off)

- **New optional entry mode for the ORB backtest that enters on a *retest* of the opening-range edge instead of the breakout candle.** With `ORB_RETEST_ENABLED=true`, the engine arms on the breakout but doesn't buy; it enters only once a later candle pulls back to within `max(ORB_RETEST_TOL_MIN=5pt, ORB_RETEST_TOL_PCT=0.1×range)` of the broken OR edge **and** closes back on the breakout side (level held), within `ORB_RETEST_MAX_WAIT=6` candles — otherwise no trade that day. Motivation: across 2021–2026 the immediate-entry ORB wins only ~17% (profit factor 0.60); the dominant losers are poke-and-reverse false breakouts, which a retest filters out. The known cost is skipping runaway-trend days that never pull back (some of the biggest winners). **Default off; backtest-only for now** — not wired into paper/live (would need porting into `orb_breakout.getSignal`). Exposed as four Settings knobs and documented in the backtest notes panel; the results page self-labels when the gate is on. `runOrbBacktest` is now exported for offline unit-testing of the entry/exit engine.

### Backtest — "🤖 Download for AI" on every backtest page

- **Every backtest results page (EMA_RSI_ST / BB_RSI / PA / EMA9+VWAP / ORB) now has a "🤖 Download for AI" button** next to "📋 Copy Trade Log". It downloads a self-describing Markdown report — summary stats, a plain-English field legend, then the full trade table — that you can paste straight into an AI for analysis. Same shape as the Trade Logs "🤖 AI" export, so both read the same. Backtest results are ephemeral (no JSONL on disk), so the report is built in the browser from the trades already embedded in the page via a shared helper ([backtestAiExport.js](src/utils/backtestAiExport.js)) — no new route or server round-trip. P&L is labelled ₹ or pts to match the page (δ+θ option sim vs raw index points), and the header notes when the embedded set is capped for browser performance.

### ORB backtest — background job + batched fetch (fixes 0-trades on long ranges)

- **The ORB backtest ran its whole candle fetch synchronously inside the HTTP request.** The fetch chunks the range into months (350ms rate-limit sleep + retries each), so a multi-month/multi-year range runs for minutes — past the HTTP/proxy timeout. The request then returned an empty candle set and the page rendered **0 trades** even over 5 years (the `runOrbBacktest` engine itself is fine — it produces trades on the same candles). Converted the route to the **same background-job pattern the EMA_RSI_ST backtest uses**: `GET /orb-backtest` now creates a job, runs the fetch + backtest in the background with a live progress page, and polls `GET /orb-backtest/status` until done — the server stays responsive and long ranges complete. Too-few-candles now **fails the job with a clear message** instead of silently showing 0 trades. `/orb-backtest/idle` now reports the shared job-manager idle state.

### ORB — replay now prices exits correctly (option-poll timer fix)

- **ORB's in-trade option-LTP poll used `setInterval(3s)`; every other strategy uses a recursive `setTimeout`.** The replay harness ([tickReplay.js](src/services/tickReplay.js)) accelerates polling by collapsing short `setTimeout` delays to 0ms so `state.optionLtp` tracks replay-time — but it never patches `setInterval`. So in replay ORB's option price stayed frozen at the entry premium: exits were mispriced (a Jul-8 replay showed `optionEntryLtp == optionExitLtp == bestOptionLtp == 178.95`, i.e. the option never updated even though the recorded ticks clearly moved). Switched both `orbPaper.js` and `orbLive.js` to the same recursive-`setTimeout` poll the other routes use — identical 3s cadence in live, but replay now advances the option LTP tick-by-tick and prices the exit at the real premium. (Still cannot price a hold that runs *past* the original trade's exit — no option ticks were recorded there; that needs a fresh live-paper session.)

### ORB — breakout buffer + trend-following exit (rewrite 2026-07-09)

- **Entry now requires the close to CLEAR the OR edge by a buffer**, not merely touch it: `close > ORH + buffer` (CE) / `close < ORL − buffer` (PE), where `buffer = max(ORB_BREAKOUT_BUFFER_MIN=8, ORB_BREAKOUT_BUFFER_PCT=0.15 × range)`. The old test was a bare touch (`close > ORH`), so a poke of a fraction of a point beyond the edge qualified — every such near-touch in the Jul 6–9 live-paper cohort reversed straight back. Replaying that cohort through the new `getSignal`: the two pure false breakouts (Jul 7 −₹1,812 at 2.25pt beyond; Jul 9 −₹554 at 0.25pt beyond) are now **blocked**, while the genuine breakout (Jul 6 +₹397) and the directionally-correct trade (Jul 8) still fire.
- **`ORB_MAX_RANGE_PTS` default tightened 120 → 100** (an open that has already run 100+ pts in 15 min is exhausted; this also blocks the wide-range Jul 9 entry).
- **Exit rewritten from the 2-candle swing trail to a trend-following model.** The old `ORB_SL_CANDLES` stop hugged price within ~15–30pt and exited winners on the first pullback (Jul 6 booked +₹397 of a +₹1,014 peak; Jul 9 round-tripped +₹504 → −₹554; Jul 8 was stopped 09:46 *before* a 400pt down-move). Replaced with: initial hard SL = breakout candle low/high → breakeven after `ORB_BREAKEVEN_PTS=20` → **EMA trend-trail** `ORB_TRAIL_EMA=20` (exit only when a candle *closes* back across the EMA) → strong-opposite-candle exit (`ORB_OPP_CANDLE_EXIT`, `ORB_OPP_CANDLE_BODY_MULT=0.3`) → **per-trade loss cap** `ORB_MAX_TRADE_LOSS=1500` (the daily-loss kill only fires when flat, so it never capped a single open trade — Jul 7 lost ₹1,812 under a ₹500 "daily limit").
- **EMA seeding**: paper + live now preload ~7 calendar days of 5-min candles so the 20-EMA trail is live even for a 09:35 entry (today's bars alone can't supply 100 min of history). The opening range + session VWAP are now **day-scoped** in `orb_breakout.js` so the prior-day candles seed the EMA without leaking into today's OR.
- **Removed key**: `ORB_SL_CANDLES` (no longer read). **New keys** (all in Settings + README): `ORB_BREAKOUT_BUFFER_MIN`, `ORB_BREAKOUT_BUFFER_PCT`, `ORB_TRAIL_EMA`, `ORB_BREAKEVEN_PTS`, `ORB_OPP_CANDLE_EXIT`, `ORB_OPP_CANDLE_BODY_MULT`, `ORB_MAX_TRADE_LOSS`. Applied to all three modes (paper canonical; live + backtest aligned). **`.env` note**: a running instance with `ORB_MAX_RANGE_PTS=120` set explicitly keeps 120 — change it to 100 in Settings to pick up the tighter default.

### Fix — charts self-hosted (no more blank graphs when the CDN is unreachable)

- **All strategy charts (ORB / EMA_RSI_ST / BB_RSI / PA / EMA9+VWAP paper + live, plus Replay) blanked out whenever the browser couldn't reach `unpkg.com`.** Every chart page loaded the Lightweight Charts library from that CDN at page-load; when the request failed the render code hit `if (typeof LightweightCharts === 'undefined') return;` and drew nothing — an empty box with only the legend, while the trades table still rendered. A single CDN/network hiccup took out every chart app-wide at once.
- The library (`lightweight-charts@4.1.3`, 160 KB) is now **vendored into the repo** at `src/public/vendor/` and served locally via a new `express.static` mount at **`/vendor`** (added in `app.js` before the login gate, cached immutable). All 11 chart pages now load `/vendor/lightweight-charts.standalone.production.js` — zero external CDN dependency.

### BB_RSI — PSAR removed; SuperTrend is now the sole trend source (V7)

- **Parabolic SAR is fully removed from BB_RSI.** The strategy previously used PSAR by default with SuperTrend as an opt-in alternative (`BB_RSI_USE_SUPERTREND`). SuperTrend(10,3) is now the **only** trend source — it drives the directional entry confirmation (CE = SuperTrend bullish / PE = bearish), the initial SL line, and the candle-close trend-flip exit. Entry is **BB break + SuperTrend side + RSI**; exit is profit-lock / hard-stop / BB re-entry / **SuperTrend flip** (unchanged except the flip source). Strategy renamed `BB_RSI_BB_PSAR_RSI_V6.1` → `BB_RSI_BB_SUPERTREND_RSI_V7`.
- **Removed env keys / Settings fields**: `BB_RSI_PSAR_STEP`, `BB_RSI_PSAR_MAX`, `BB_RSI_USE_SUPERTREND`. `BB_RSI_SUPERTREND_PERIOD(10)` / `BB_RSI_SUPERTREND_MULT(3)` are kept as the plain SuperTrend inputs (no longer gated behind a toggle); `BB_RSI_MAX_ENTRY_SL_PTS(50)` now measures distance to the SuperTrend line.
- **UI**: the Settings section is relabelled *BB_RSI Strategy (BB+SuperTrend+RSI) — Fyers*; the PSAR-vs-SuperTrend toggle and its row-greying JS are gone. Paper/live charts drop the purple PSAR dot series and show only the coloured SuperTrend line. Docs synced (`README.md`, `BB_RSI.md`).

### **Reset Data** dialog on the Logs page (categories + date range)

- Replaces the Settings **🧹 RESET ALL PAPER** button (removed from Settings). A **🧹 Reset Data** button now lives in the **Logs (`/trade-logs`) page top bar** and opens a category picker instead of one-shot wiping every strategy's paper summary. Categories: **Paper trade history**, **Skip trade history**, **Cache**, **Logs**, **Ticks data** — with a **select-all** and an optional **date range**.
  - The date range filters dated files only: paper daily JSONL (`trades/{mode}_paper_trades_*.jsonl`), skip daily JSONL (`skips/{mode}_paper_skips_*.jsonl`), and tick day-folders (`ticks/YYYY-MM-DD/`). **Cache and Logs always clear fully** (no per-day dimension).
  - Checking **Paper** with **no** date range preserves the old behaviour: fans out to the 5 per-strategy `/{strategy}-paper/reset` routes to restore starting capital + wipe sessions (a running strategy is skipped). With a date range, only the matching daily paper files are removed — capital/sessions untouched.
  - New `POST /settings/reset-data` (API_SECRET-gated) performs the file deletions, reusing `tradeLogger.listDailyDates`/`dailyFilePathFor`, `skipLogger.listDates`/`filePathFor`, and a new `tickRecorder.deleteRecordingsInRange({from,to})`. Cache clears `~/trading-data/{backtest_cache,candle_cache}`; Logs clears the in-memory `logStore` (same as `POST /logs/clear`).

### Performance & resilience hardening (t3.micro) — no trading-decision changes

Audit-driven fixes to protect the single shared process on a 1 GB EC2 t3.micro. **None of these change any strategy's entry/exit/fill decisions** — they remove event-loop stalls, blocking calls, unbounded growth, and redundant broker/disk work.

- **EMA9+VWAP backtest no longer freezes the live feed.** `ema9vwapBacktestEngine.js` was `async` but had zero `await` and re-`slice()`d the candle window every iteration — a multi-year run blocked the event loop (and the live Fyers tick feed hosted in the same process) for 10–60 s. Added the standard `setImmediate` yield every 100 candles and reused a rolling 200-candle window via push/shift. `getSignal()` sees an identical view, so **backtest results are unchanged** — only the blocking is gone.
- **Broker circuit-breaker alerts no longer block the event loop.** `brokerSafety.js` sent its "circuit OPEN / recovered" Telegram via `sendTelegramSync` (a blocking `spawnSync` curl, up to ~5 s) — firing mid-session exactly when the broker is flaky, freezing live SL checks. Switched to the async fire-and-forget `sendTelegram`. Same message, no freeze.
- **Login-attempt log is now capped** at 2000 newest entries. It was rewritten whole-file, synchronously, on every failed login with no cap — an internet-exposed login gets bot-scanned continuously, so the file (and the per-probe parse+rewrite) grew unbounded.
- **Boot data-backup deferred during market hours.** `backupManager.start()` cut a ~150–300 MB tar+gzip at boot if the day's snapshot was missing — pinning a vCPU and burning CPU credits while the feed warmed up after a restart. Now skipped 09:00–15:30 IST; the scheduled daily run (and manual `POST /backup/create`) still guarantee a file.
- **Backtest-results file cached by mtime.** `resultStore.loadAll()` re-read+parsed the multi-MB `backtest_results.json` on every call, and `/all-backtest` calls it 4–5× per page view. Now memoised behind an mtime+size signature, invalidated on save.
- **Restored-session chart backfill negative-caches misses.** `chartBackfill.js` only cached complete days, so a stopped strategy's status page re-hit the Fyers historical API every 4 s. Failed/incomplete-day lookups are now negative-cached for 60 s (≈1 broker call/min instead of 15).

### Reliability fixes (live-harness logging + replay determinism)

- **Live-harness trades are now actually logged.** The harnesses call `tradeLogger.appendTradeLog("{mode}-live", …)`, but `tradeLogger` had no `-live` mode keys, so every real live-harness trade threw "unknown mode" and was silently dropped. Registered `{ema_rsi_st,bb_rsi,pa,orb,ema9vwap}-live` file/prefix keys. (Only fires on real orders — dry-run runs were unaffected either way.)
- **Replay snapshots now pin more settings.** `tickRecorder`'s settings-snapshot whitelist missed `EMA9VWAP_*` (not matched by `/^EMA_/`), the `OI_FILTER_ENABLED` master switch, `OPT_*` (EMA_RSI_ST option stop), `TIME_STOP_*`, `NIFTY_LOT_SIZE`, and `LTP_STALE_*` — so snapshot-mode replays silently used *today's* env for those. Added the matchers. `tickReplay`'s expiry-pin list gained the `EMA9VWAP_OPTION_EXPIRY_*` keys so sim-mode EMA9+VWAP replays pin the recorded expiry instead of leaking the current one. (Only affects sessions recorded *after* this change.)

### Cross-mode consistency: align backtest/live to canonical paper

A cross-mode audit (paper is canonical) found the paper engines sound and replay faithful, but several **backtest** engines skipped guards paper enforces, and one paper bug affected live too. Fixes (paper decision logic unchanged except the bb_rsi bug, which was explicitly approved):

- **BB_RSI BB re-entry exit used a frozen band after ~14:20 IST** (paper **and** live). The per-tick Bollinger cache was keyed on `candles.length`, which pins at the 200 cap once reached, so the band never recomputed for the rest of the session. Now keyed on the last closed candle's time (recomputes each close — the code's documented intent). *This changes bb_rsi's realized exits; collect fresh bb_rsi sessions before tuning on them.*
- **EMA9+VWAP daily caps now honour the per-strategy keys.** Paper read the global `MAX_DAILY_TRADES/LOSS` while backtest + Settings + README used `EMA9VWAP_MAX_DAILY_*`, so the Settings field was a no-op and backtest diverged. Both paper and backtest now read `EMA9VWAP_* → global → default`; with only the global keys set (current `.env`) paper's behaviour is unchanged, and the backtest now mirrors it.
- **EMA9+VWAP backtest now enforces the guards paper does.** The engine took entries paper would block — it had no VIX gate, opposite-side (flip) cooldown, 3-consecutive-loss pause, or latched daily-loss. Ported all four to mirror paper (same keys/defaults/fail-modes), threaded the historical VIX candles the route already fetched, and stopped it re-entering on a candle that just closed a position.
- **EMA_RSI_ST backtest EMA21 trail no longer looks ahead.** It raised the SL to *this* candle's EMA21 and then tested this candle's low/high against it; paper arms EMA21 at a close and enforces it on the next candle. The trail now uses the prior candle's EMA21.
- **EMA_RSI_ST backtest 3-consec-loss breaker now matches paper.** Was an escalating pause that never reset the counter and never triggered the 15-min daily kill; now: 15-min → latch the day off, 5-min → pause 4 candles + reset. The daily-loss cap is now a latch (as in paper) so the kill actually blocks entries.
- **Backtest theta decay no longer over-charged on sub-15-min runs.** The option-sim `candles-per-day` divisor was hardcoded to `26` (the 15-min-bar count) in the EMA_RSI_ST/shared engine and the EMA9+VWAP engine, and was read from an env var (not the run's resolution) in BB_RSI/PA. So a **5-min** run charged theta as if each bar were 15 min — ~3× too much decay per candle (₹25 vs ₹8.3/candle at lot 65), inflating every trade's loss and shrinking winners. All five engines now derive candles-per-day from the **actual bar spacing** (`390 / resolution` → 26 on 15-min, 78 on 5-min); 15-min results are unchanged, sub-15-min P&L improves. (ORB was already correct — its `/78` matches its fixed 5-min.)

### Live-order gate enforced on the harness path

- **`{STRATEGY}_LIVE_ENABLED` is now enforced on all five live harnesses** (`ema_rsi_st/bb_rsi/pa/orb/ema9vwap`), matching what the README/Settings already documented (default-off; real orders require it `=true`). Enforced **only for real orders** — dry-run runs are unaffected, so nothing changes while `LIVE_HARNESS_DRY_RUN=true`.

### Known gaps (documented, not yet fixed)

- **Harness-path crash-recovery is not wired for any strategy.** The `.active_*_position.json` snapshots are written by the legacy `*Live.js` routes only; the paper-wrapping harnesses (the documented live path) don't persist open positions, and EMA9+VWAP (harness-only) never writes one at all. Wiring it needs care (persisting a dry-run or pure-paper position would make boot reconciliation falsely report a broker "orphan"), so it's left for a dedicated change.
- **Backtest ±1-candle EOD/entry-window edges remain.** Most backtests gate on a candle's bucket-*start* minute rather than its close, so they can enter/exit one candle later than paper. Left as-is this round (only the guard gaps above were in scope).

### Logs hub: Login Logs, Server Logs & Cache Files folded into the Logs page as tabs

- **What**: the sidebar's **Trade Logs** entry is renamed **Logs**, and the **🔐 LOGIN LOGS**, **📜 LOGS**, and **🧰 CACHE FILES** buttons are removed from the Settings top bar. Those three views now live as tabs on the Logs (`/trade-logs`) page — alongside the existing Trade Files, Skip Logs, and Checkpoints tabs.
- **How**: `/login-logs`, `/logs`, and `/cache-files` each gained an `?embed=1` mode that drops their sidebar and own top-bar; the Logs page renders each inside an `<iframe>` (lazy-loaded on first tab open) so the pages keep all their existing logic — nothing was duplicated. The old `UI_SHOW_LOGS` / `UI_SHOW_CACHE_FILES` toggles now gate the **Server Logs** / **Cache Files** tabs (Login Logs is always shown). The standalone routes still work when visited directly.

### Settings: one-click "Reset ALL Paper" across every strategy

- **What**: a new **🧹 RESET ALL PAPER** button in the Settings top bar that wipes paper-trade history and restores starting capital for **all** strategies at once — EMA_RSI_ST, BB_RSI, PA, ORB, EMA9+VWAP — instead of visiting each strategy's page and resetting it individually.
- **How**: it fans out to each strategy's existing `/{name}-paper/reset` route (the canonical reset logic), so **tick recordings and the per-day trade-log JSONL are left intact** — Replay still works after a reset. A strategy that is currently running is skipped (its own reset guard rejects while a session is live) and reported as such; the run ends with a summary of what was reset / skipped / failed. Double-confirm gated.

### EMA9 + VWAP: chart on Live page + TradingView-matched styling + Telegram toggles

- **Live page now draws the price chart.** `/ema9vwap-live` previously showed only status + a JSON event log; it now renders the same candlestick chart as Paper/Replay, fed by the paper engine's `/ema9vwap-paper/status/chart-data` (the harness drives that engine underneath), so all three surfaces show the same picture.
- **Chart recoloured to match the user's TradingView setup** on Paper, Live, and Replay: **EMA9 = white**, **VWAP = blue**, **VWAP ± σ = solid green / red** (was EMA9 purple, VWAP white, dashed bands). Replay's recolour is scoped to EMA9+VWAP only (detected by carrying both an `ema9` and a `vwap` series) so ORB/EMA_RSI_ST replay charts are untouched.
- **Telegram toggles added to Settings.** The `COMMON — Telegram` section now exposes EMA9+VWAP rows (`TG_EMA9VWAP_STARTED / _ENTRY / _EXIT / _SIGNALS / _DAYREPORT`) alongside the other strategies. `notify.js` already gated EMA9+VWAP alerts on these keys — they were just missing a UI switch (defaulted on, except `_SIGNALS` off, matching BB_RSI/PA).

### EMA9 + VWAP: 2-candle reversal exit

- **What**: a new candle-close exit for the EMA9+VWAP strategy — after entry, square off immediately when the just-closed candle reverses hard against the position: a **CE** bails on a **bearish** candle (`close < open`) that closes **below both** of the previous 2 candles' lows; a **PE** on a **bullish** candle that closes **above both** of the previous 2 candles' highs. Rolling reference (each closed candle is measured against its own prior 2). Evaluated on candle close only — a wick that reverses before the candle closes does not trigger it.
- **Where**: implemented in the canonical paper engine (`ema9vwapPaper.js` `onCandleClose`, checked ahead of the pure signal exit) and mirrored in the dedicated backtest engine (`ema9vwapBacktestEngine.js`). The Live harness wraps paper, so LIVE inherits it by construction. The exit uses `simulateSell` so the existing opposite-side cooldown blocks an instant flip after the reversal.
- **Toggle**: `EMA9VWAP_REVERSAL_EXIT_ENABLED` (default **on**), exposed in **Settings** ("2-Candle Reversal Exit"). Set to `false` to hold purely to the signal / EOD exit. Trades exit with reason `2-candle reversal exit`, grouped as "2-Candle Reversal" in the paper daily journal.

### New strategy: EMA9 + VWAP-band crossover (Paper / Backtest / Live / Replay)

- **What**: a new 5-minute intraday strategy, `EMA9_VWAP`, structurally cloned from EMA_RSI_ST but with a simpler entry/exit:
  - **CE**: EMA 9 (on 5-min close) crosses **above** the VWAP **top line** (`VWAP + mult·σ`). **PE**: EMA 9 crosses **below** the VWAP **bottom line** (`VWAP − mult·σ`).
  - **Exit is a PURE signal exit** — hold the full position until EMA 9 crosses back **inside** the band (CE → back below the top line, PE → back above the bottom line). No stop-loss, target, or trail. EOD hard square-off at **15:15 IST**.
  - **Entry window 10:30 → 14:30 IST** (a trailing position keeps running past 14:30 until the re-cross or the 15:15 square-off). Signals are evaluated on **candle close** ("wait for timeframe close").
- VWAP is **session-anchored, HLC3, with Standard-Deviation bands** matching the TradingView default (`Bands Multiplier #1 = 1`). Tunable via `EMA9VWAP_BAND_MULT` (0 collapses the band to the plain VWAP line). NIFTY spot has no real volume, so this VWAP is effectively a session **TWAP±σ** — same convention ORB already documents.
- **Surfaces**: `/ema9vwap-paper` (canonical engine, Fyers ticks), `/ema9vwap-backtest` (dedicated candle-loop engine that mirrors the paper decisions, not the generic EMA_RSI_ST engine), `/ema9vwap-live` (LIVE = PAPER via the harness, **Zerodha** orders, double-gated by `EMA9VWAP_LIVE_ENABLED` + `LIVE_HARNESS_DRY_RUN`). Wired into the unified **Real-Time monitor**, **Replay**, the **Dashboard** rollup (Zerodha wallet pool), the cross-strategy **Paper Traded History** (`/consolidation`) + **Edge Analytics** (`/edge-analytics`) + consolidated **EOD Telegram report**, **Settings** (new "EMA9 + VWAP STRATEGY — Zerodha" section + `EMA9VWAP_MODE_ENABLED` master toggle + `UI_SHOW_EMA9VWAP_*` submenu toggles), and the sidebar (gated by `EMA9VWAP_MODE_ENABLED`).
- Runs **in parallel** with EMA_RSI_ST/BB_RSI/PA/ORB on the shared Fyers socket (registers as a secondary fan-out callback — never steals the primary feed) with its own `sharedSocketState` mode (`EMA9VWAP_PAPER`/`EMA9VWAP_LIVE`) and data files (`ema9vwap_paper_trades.json`, `trades/ema9vwap_paper_trades_*.jsonl`). No existing strategy's behaviour changes. (Crash-recovery snapshot helpers for `.active_ema9vwap_position.json` exist and boot reconciliation reads them, but the harness-path save is not yet wired — see the "known gaps" note below.)
- The EMA_RSI_ST/BB_RSI/PA engines' shared-socket teardown guards were extended with a single additive `&& !isEma9VwapActive()` clause so stopping one of them never tears the socket out from under a running EMA9+VWAP session (the guard can only *prevent* a wrongful stop, never cause one). The notify layer (`modeGroup`/`modeLabel`) gained an `EMA9VWAP` branch so its Telegram alerts are gated by `EMA9VWAP_MODE_ENABLED` and labelled correctly instead of being mis-attributed to EMA_RSI_ST.

### ORB: volume-confirmation filter OFF by default (NIFTY spot has no real volume)

- **`ORB_VOL_FILTER_ENABLED` default flipped `true` → `false`** ([src/strategies/orb_breakout.js](src/strategies/orb_breakout.js), [src/routes/settings.js](src/routes/settings.js), [src/routes/docs.js](src/routes/docs.js), README).
- **Why**: NIFTY spot has no traded volume. Paper/live ORB candles carried a per-tick **count** as "volume" (`currentBar.volume++`), while backtest candles (fetched from history) carry **zero** — so the volume gate was active in paper/live but silently skipped in backtest, and even when active it compared tick-counts, not real volume. The three modes could never agree on it. Disabling it makes paper, live, and backtest evaluate ORB identically.
- The **VWAP filter is unchanged but relabelled honestly**: on a volumeless index it is always a TWAP (equal-weighted) alignment check, not a true volume-weighted VWAP. Settings label is now "VWAP / TWAP Alignment Filter".
- **Note**: the code default only applies when the key is **absent**. If your server `.env` (written by the Settings UI) still has `ORB_VOL_FILTER_ENABLED=true`, toggle it **off** in Settings → ORB to actually disable it.

### Backtest EOD square-off times now mirror paper (no more hardcoded 3:20 PM)

- The BB_RSI, PA, and EMA_RSI_ST backtests hardcoded a 3:20 PM (`candleMin >= 920`) end-of-day square-off. They now read the **same env keys as the paper routes** so a Settings change to the cutoff moves the backtest too, and so backtest results match paper.
  - **BB_RSI** ([src/routes/bbRsiBacktest.js](src/routes/bbRsiBacktest.js)) + **PA** ([src/routes/paBacktest.js](src/routes/paBacktest.js)): EOD square-off = `TRADE_STOP_TIME − 10` (paper's `_STOP_MINS − 10`). Same as before at the 15:30 default (15:20), but now follows Settings.
  - **EMA_RSI_ST** ([src/services/backtestEngine.js](src/services/backtestEngine.js)): paper has **two** distinct times that the backtest had collapsed into one — exit square-off at `EMA_RSI_ST_EOD_EXIT_TIME` (**15:15**) vs entry cutoff at `TRADE_STOP_TIME − 10` (**15:20**). They are now split: the backtest squares off at 15:15 (was 15:20, a real 5-min divergence) and blocks new entries at 15:20, matching paper exactly.
- Backtest-only change; no live/paper behaviour changed. (The entry **cutoffs** — `BB_RSI_ENTRY_END` / `PA_ENTRY_END` / `ORB_ENTRY_END` — were already env-driven and unchanged.)

### BB_RSI: confirmation candle must CLOSE outside the Bollinger band

- **New entry guard** (`BB_RSI_CONFIRM_OUTSIDE_BAND`, **default ON**; needs `BB_RSI_CONFIRM_CANDLE_ENABLED=true`): the confirmation is now evaluated at the next candle's **close** — that candle must **close** beyond the signal candle's close (the cross) **and** close **outside the band** (CE above upper / PE below lower). Entry fires at that close, not intra-bar.
- **Why**: previously the confirmation entered **intra-bar** the instant price first poked past the signal candle's close. On a failed breakout that poke closes back **inside** the band, so the entry candle — which carries the entry arrow on the chart — sat visibly *inside* the band, which read as "entries taken from inside the BB". (Compounding it, a sharp signal candle whips the 20-period band wider on the next candle.) Requiring the confirmation candle to *close* beyond the band guarantees every entry candle is genuinely outside it, and filters the one-poke false breakouts that drove the churn losses.
- **Applied across all three surfaces** — paper ([src/routes/bbRsiPaper.js](src/routes/bbRsiPaper.js)) + live ([src/routes/bbRsiLive.js](src/routes/bbRsiLive.js)) confirm at candle close in `onCandleClose` (the per-tick intra-bar path is skipped when the guard is on); backtest ([src/routes/bbRsiBacktest.js](src/routes/bbRsiBacktest.js)) mirrors it (close-cross + close-outside-band, entry at the close). The shared direction/comparison lives in [src/utils/confirmCandle.js](src/utils/confirmCandle.js) (`beyondBand` / `outsideBandEnabled`). Toggle OFF (Settings → BB_RSI) for the legacy intra-bar cross entry — A/B via `/replay`.

### EMA_RSI_ST: signal candle must CLOSE beyond the base EMA (close-beyond-EMA gate)

- **New entry gate** (`EMA_RSI_ST_CLOSE_BEYOND_EMA_ENABLED`, **default ON**): the signal candle's **close** must sit on the trade side of a *base EMA* — **CE: close above, PE: close below**. The base EMA follows the EMA-stack toggle: **EMA-fastest (9) when `EMA_RSI_ST_EMA_TRIPLE_STACK_ENABLED` is ON, else EMA-fast (20)** — using whatever periods are configured (`EMA_RSI_ST_EMA_FASTEST` / `EMA_RSI_ST_EMA_FAST`), nothing hardcoded.
- **Why**: the EMA-stack / 2-EMA gate only checks EMA *ordering* (e.g. 9>20>50), not where price sits. After a morning rally the lines stay stacked and SuperTrend stays green through a midday chop, so the strategy kept buying **CE into dips that closed *below* EMA9** — the 23-Jun false breakouts entered ~3pt and ~9pt below EMA9 (`ema9AtEntry` > `spotAtEntry`), each immediately hitting the prev-candle stop, and the two losses then latched the chop guard and sat out the afternoon trend. The gate blocks exactly those bars.
- **Applied in the shared `getSignal`** ([src/strategies/strategy1_sar_ema_rsi.js](src/strategies/strategy1_sar_ema_rsi.js)) so **paper, live, and backtest all inherit it** (all three arm/enter off the same signal). When a bar is blocked, the skip log / no-signal reason reads `C <close> <=EMA<n> <ema> (need close above)`. Entry reasons gain a `| C <close>>EMA<n> <ema>` token. Toggle OFF (Settings → EMA_RSI_ST) to restore the ordering-only gate — A/B via `/replay`.

### AI-friendly trade export across all trade-data download screens

- **New: every trade-data download now has a "🤖 AI" option** that produces a single self-describing Markdown report instead of raw JSONL/CSV — built for pasting straight into an AI for analysis. Each report carries a **summary table** (per-mode + total: trades, wins/losses, win %, net P&L, avg win/avg loss), a **field legend** (plain-English meaning of every field actually present), the **settings snapshot** that produced the trades (where available), then **per-strategy trade tables**.
- **Where it appears**: Trade Logs — both the **Trades** and **Skips** tabs: *Download Everything* (`?format=ai`, range-aware on Trades), per-mode *Download All*, and per-day *Download*; Consolidation and Live Consolidation (🤖 AI button next to ⬇ CSV — exports exactly the filtered set shown); and each Paper screen (EMA_RSI_ST/BB_RSI/PA/ORB) via a *🤖 AI export* link that downloads the full per-trade log.
- **Skip logs** get a skip-shaped report instead of P&L stats: a per-gate breakdown (e.g. `vix (12), spread (5), strategy (3)`), a legend for the skip fields (gate / reason / spot / rsi / adx), then the rejections grouped by strategy — so an AI can answer "why didn't it trade?".
- **No new pages or menu items** — the option sits inline next to the existing download buttons, so there's nothing new to enable in Settings.
- **One shared format**: server-side file exports go through [src/utils/aiExport.js](src/utils/aiExport.js); the browser-filtered screens (Consolidation) render the identical structure via `aiExportJS()` in [src/utils/sharedNav.js](src/utils/sharedNav.js). Purely additive — no decision/fill/exit logic touched.

### EMA_RSI_ST + BB_RSI: two-candle "cross & close" entry confirmation

- **New: entry now waits for a confirmation candle** (`EMA_RSI_ST_CONFIRM_CANDLE_ENABLED` / `BB_RSI_CONFIRM_CANDLE_ENABLED`, both **default ON**). A fully-closed candle that meets all the strategy's entry rules becomes the *signal candle* — but no trade is taken on it. The **immediately-next** candle must then **cross that signal candle's close** (CE strictly above, PE strictly below); entry fires **intra-bar** the instant the cross happens. If the next candle never crosses, the armed signal expires; if that next candle is itself a fresh signal it re-arms (rolling). Filters the one-candle false breakouts that drove the losing CE entries on 22-Jun.
- **Behaviour change per mode**: EMA_RSI_ST previously entered intra-candle the moment the live bar met the rules; BB_RSI entered at the signal candle's close. Both now gate on the next-candle cross. Turn the toggle OFF (Settings → EMA_RSI_ST/BB_RSI) to restore the old behaviour — A/B the two in `/replay`.
- **Applied across all six surfaces** — `emaRsiStPaper`/`emaRsiStLive` + the shared EMA_RSI_ST `backtestEngine`, and `bbRsiPaper`/`bbRsiLive`/`bbRsiBacktest` — so paper, live, and backtest agree. Confirmation logic shared via [src/utils/confirmCandle.js](src/utils/confirmCandle.js) (toggle name, strict cross direction, and the backtest candle-granularity fill live in one place). Backtests model the intra-bar cross with the next candle's high/low and fill at the trigger (or the bar's open if it gapped through). All entry gates (VIX, OI, cooldowns, daily-loss, max-trades, spread) still apply — they're enforced at the cross (EMA_RSI_ST) or at arm time on the signal candle's close (BB_RSI), exactly once.
- **Replay** runs the real paper `onTick`/`onCandleClose`, so it inherits confirmation automatically (verified the arm timing matches live — `tickReplay` flushes microtasks per tick). **Old-recording reproducibility**: snapshot-mode replay of sessions recorded *before* this feature (no `*_CONFIRM_CANDLE_ENABLED` in their snapshot) now forces the toggle **OFF** so they reproduce their original entries; `REPLAY_CACHE_VERSION` bumped to 7 to drop any results cached with confirmation wrongly ON. The live harnesses (which wrap paper) log the inherited confirm state on start.
- **UI**: the Paper/Live status banner now shows `🎯 ARMED <side> — waiting for next candle to cross <level>` (instead of always `FLAT`) while a signal candle has fired but isn't yet confirmed — on all four screens (server-render + the live 2 s poll) — and the chart draws a dashed amber `ARM` line at the trigger level until the cross or expiry. The activity log already records the arm and the cross.

### Paper screens: trades + chart markers survive a server restart

- **Fixed: pushing code (which restarts the server) wiped the running session's trades and chart markers from every Paper screen** (EMA_RSI_ST/BB_RSI/PA/ORB). The Session Trades table and the entry/exit markers are drawn from the in-memory `sessionTrades`, which was only persisted to the saved `sessions[]` on **Stop**. A mid-session PM2 restart cleared it, so the screen came back empty even though the trades were safe in the per-trade JSONL day log.
- **Each paper mode now rehydrates the current session from today's JSONL on boot** — it loads today's trades that aren't already in a saved (stopped) session, restoring `sessionTrades`, `sessionPnl`, and the win/loss counts. In-memory only: **Stop** still does the persisted `sessions[]` save, so there's no double-counting. Settings-snapshot/meta lines in the day file are skipped; only real trade records are restored.
- **Fallback so the screen is never blank after a restart**: when there are no live trades for today (e.g. a restart outside market hours), each paper screen loads the **most recent saved session** instead. It's read-only display — `Start Paper` resets it to a fresh session, so the old trades can't be re-saved or double-counted. The `SESSION START` field shows that session's date as a hint. (Finished sessions also remain available under **History**.)
- **The chart comes back too, not just the table.** The candle series is live-only (`state.candles` fills from ticks), so a restored session still charted blank. Each chart now backfills the **spot candles for the restored trades' day** so the entry/exit markers (and EMA/SuperTrend/BB/ORB overlays) render ([src/utils/chartBackfill.js](src/utils/chartBackfill.js)). It does a **direct historical fetch** of the trade day (+ ~6 warmup days), falling back to the candle cache — the cache alone often holds only that day's *morning preload* (a partial day), which would clamp the afternoon markers to the chart edge. A **reach-check** guards exactly that: if the candles don't actually extend to the latest trade, the chart shows **nothing** rather than markers stacked at the wrong place (the Session Trades table still lists them; full history is in Replay / History). Result memoised per symbol/resolution/day. Only triggers when **stopped with restored trades and no live candles** — live polling is untouched. (After hours this needs a still-valid broker token for the historical fetch; during/around market hours it's reliable.)
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

- **The Straddle (Long Straddle / BB-squeeze volatility) strategy has been removed entirely.** Deleted its routes (`/straddle-paper`, `/straddle-live`, `/straddle-backtest`), the `straddle_volatility.js` strategy, and the `Straddle_Strategy_Guide.html` doc. The platform now runs **four** strategies: EMA_RSI_ST, BB_RSI, Price Action, and ORB.
- **All wiring scrubbed:** `app.js` route mounts + dashboard/monitor cards + shutdown reconciliation; `sharedSocketState` (`STRADDLE_PAPER`/`STRADDLE_LIVE` modes + helpers); `sharedNav` sidebar group; `settings.js` (the full Straddle strategy section, `STRADDLE_MODE_ENABLED`, the `UI_SHOW_STRADDLE_*` submenu toggles, and the `TG_STRADDLE_*` Telegram toggles); `realtime.js` card + position renderer; `replay.js` / `tickReplay.js` mode maps + socket-state stubs; `consolidation` / `edgeAnalytics` / `tradeLogs` / `cacheFiles` / `allBacktest` source maps + filters; `notify.js` (per-leg pair-stats + STRADDLE group); `vixFilter` per-mode readers; `tradeLogger` / `skipLogger` file maps; and the OI-filter exclusion note.
- **Env keys retired:** `STRADDLE_*`, `UI_SHOW_STRADDLE_*`, `TG_STRADDLE_*`, `STRADDLE_MODE_ENABLED` are no longer read anywhere (leaving them set in `.env` is harmless — they're simply ignored). The consolidated Telegram day report and Real-Time monitor now cover four strategies.
- **No impact on the other four strategies** — EMA_RSI_ST/BB_RSI/PA/ORB decision, fill, exit, paper/live/backtest/replay paths are untouched. Existing `straddle_*` trade-data files in `~/trading-data/` are left in place (historical data; delete manually if desired).

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

### BB_RSI: reverted the RSI-band entry change

- **Reverted the RSI-band entry filter** (commits `f95f480` + `52ff31c`, 2026-06-19) — it made BB_RSI worse across replayed sessions. BB_RSI returns to the single-threshold rule: CE requires RSI > `BB_RSI_RSI_CE_THRESHOLD`, PE requires RSI < `BB_RSI_RSI_PE_THRESHOLD`. The four band keys (`BB_RSI_RSI_CE_MIN`/`_MAX`, `BB_RSI_RSI_PE_MIN`/`_MAX`) are retired; the two threshold keys, the Settings fields, and the docs are restored to their pre-band state.

### Replay: "current settings" mode auto-pins the recorded day's option expiry

- **Simulator (current-settings) replays now use the recorded day's option expiry instead of today's.** Previously a "My current settings" range replay applied the live `OPTION_EXPIRY_OVERRIDE` to every replayed day — so an old day was priced against this week's contract, which the recorded ticks don't cover (every quote missed → paper's spot-proxy fallback → nonsense P&L).
- The expiry keys (`OPTION_EXPIRY_OVERRIDE`/`_TYPE` and the per-mode `EMA_RSI_ST_`/`BB_RSI_`/`PA_`/`ORB_`/`STRADDLE_` variants) are now pinned to the recorded session-start snapshot; a day that auto-detected its expiry falls back to computing it from the replay clock. **Every other setting still honors current Settings** — that's the whole point of the mode. Snapshot (deterministic) mode is unchanged.

### ORB: exits replaced with a single candle-structure trailing stop

- **ORB now exits on one stop only — the swing of the last `ORB_SL_CANDLES` (default 2) closed candles** (CE → lowest low, PE → highest high), recomputed and ratcheted in the favourable direction on every candle close. The same level is both the initial SL and the trail, so winners ride until structure breaks.
- **Removed** (all of them): the −25% premium SL, the opposite-OR-edge spot SL, the +40% premium / 1.5×-range spot **profit target**, move-to-breakeven, the one-shot premium lock-in, and the continuous-premium peak-giveback trail. The 15:15 EOD square-off is kept as the only non-stop exit. `ORB_TARGET_RANGE_MULT` survives only as an informational chart line.
- Wired identically across paper (canonical), live (legacy `/orb-live` + harness), and backtest. Settings UI drops the 8 now-dead exit knobs and exposes `ORB_SL_CANDLES` (placed next to Forced Square-Off). The dead env keys (`ORB_STOP_PCT`, `ORB_TARGET_PCT`, `ORB_PREMIUM_LOCKIN_*`, `ORB_TRAIL_*`) are no longer read by ORB.
- Status pages (paper + live) relabel the position tiles to match: **Trailing SL** (the candle stop), **Initial SL**, **Peak Premium** — replacing the now-meaningless Premium Stop / Premium Target tiles. The tick-recorder session snapshot now captures `ORB_*` keys (it previously matched every other strategy prefix but not ORB), so Replay snapshot-mode reproduces ORB config faithfully.

### EMA_RSI_ST: negative-candle loss-cut + looser candle trail (chop fixes)

- **New `EMA_RSI_ST_NEG_CANDLE_LIMIT` (default 2)** — asymmetric loss-cut: if a trade is still in the **red** (option premium below entry) at the close of N candles, square it off. Winners keep riding the EMA21 trail; losers don't bleed across the chop. `0` disables. Wired identically across paper (canonical), live, and backtest; exposed in Settings.
- **Candle-trail default loosened `2` → `3` bars** (`EMA_RSI_ST_CANDLE_TRAIL_BARS`). The 2-bar trail sat right on the EMA cluster and stopped winners out on the first bounce in chop (19-Jun: most exits were the 2-bar trail, not the structural SL). A wider lookback gives winners room. _Note: the EMA9/triple-stack gate stays — skip-log review showed it filters flat-EMA chop entries rather than causing them; the churn came from the tight trail, not the entry gate._

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
- **Wiring.** Gate inserted right after the VIX check in the four directional paper routes — [bbRsiPaper.js](src/routes/bbRsiPaper.js), [paPaper.js](src/routes/paPaper.js), [emaRsiStPaper.js](src/routes/emaRsiStPaper.js) (both candle-close and intra-tick entry paths — the intra-tick path uses a synchronous cached `checkCachedOi` so the tick handler stays non-blocking), [orbPaper.js](src/routes/orbPaper.js) — with a per-candle background OI sample so the buildup series stays filled. **Straddle excluded** (delta-neutral CE+PE pair has no directional side).
- **Logged in every trade.** Entered trades record `oiAtEntry` + `oiRegime` and the regime is appended to `entryReason`; blocked entries go to the skip log under `gate:"oi"` with `oi`/`deltaOi`/`regime`.
- **Replay-safe.** OI is not recorded in tick files, so the filter is **live/paper only** — there is deliberately no backtest path and no `*Backtest.js`/`replay.js` file imports `oiFilter`. Tick-replay drives the paper routes, but its harness stubs `fyers.getQuotes`, so any OI fetch during replay returns no-data and the gate fails open — existing recordings stay valid. (The routes' `!_simMode` guards are for the in-process `/sim` synthetic tester.)
- **Settings.** Dedicated **Open-Interest Filter** section with a **master toggle** (`OI_FILTER_ENABLED`) plus per-strategy toggles (`EMA_RSI_ST_/BB_RSI_/PA_/ORB_OI_ENABLED`), `OI_LOOKBACK_CANDLES` (3), `OI_MIN_DELTA_PCT` (1), `OI_FAIL_MODE` (open) — all INSTANT, default OFF, snapshotted into each mode's daily JSONL. README env table updated.
- ⚠️ The Fyers futures-quote OI field name (`oi`) should be confirmed against a live payload before relying on blocks; the filter fails open if OI is absent.

### Feature: Edge Analytics page (`/edge-analytics`)

- **New read-only analytics dashboard that turns the trades you already record into edge metrics** — no new data is written, it just reads the same per-strategy session files as `/consolidation` (paper) and `/live-consolidation` (live), flattens them to one trade array, embeds it in the page, and computes everything client-side so the **Book (Paper/Live) · Strategy · Date-range (7D / 30D / This FY / custom)** filters recompute instantly with no server round-trip.
- **What it shows.** Eight headline cards — Trades (W/L/BE), Win Rate, Net P&L, Expectancy (₹/trade), Profit Factor (gross win ÷ gross loss), Avg Win / Avg Loss + payoff ratio, Max Drawdown (peak-to-trough on the equity curve), and Win/Loss Streaks. Below: an **equity curve** (cumulative net P&L, trade-by-trade), a **P&L-by-hour-of-day** bar chart (which entry hours actually make money) and a **P&L-by-weekday** bar chart, plus **By Strategy** and **By Exit Reason** breakdown tables (exit reasons sorted worst-net first to surface where the bleed comes from). Bars/values are green/red by sign; hover tooltips add trade count + win rate per bucket. Charts via the same Chart.js 4.4.7 CDN the other analytics pages use; theme-aware (dark/light).
- **Wiring.** New router [edgeAnalytics.js](src/routes/edgeAnalytics.js) mounted at `/edge-analytics` in [app.js](src/app.js); sidebar entry added to [sharedNav.js](src/utils/sharedNav.js) next to the history menus, gated by **`UI_SHOW_EDGE_ANALYTICS`** (default ON), with the matching **Show Edge Analytics** toggle in Settings → Menu Visibility. Hour bucketing handles both the `"HH:MM, DD/MM/YYYY"` (IST) and ISO (UTC→+5:30) entry-time formats the strategies emit. README routes + UI-visibility tables updated.

### EMA_RSI_ST: strip Parabolic SAR, make SuperTrend the only trend source, add EMA9>EMA20>EMA50 triple-stack (dormant)

- **Removed Parabolic SAR from EMA_RSI_ST entirely.** It was already dead in the live config (SuperTrend was the trend gate, EMA21 the SL), surviving only as an unused entry option, an unused SL-mode, and passive log/record/chart fields. Analysis of 48 paper trades (01–12 Jun) confirmed it had no role — and would have *blocked* the three biggest winners (SAR disagreed with the correct SuperTrend call). `calcSAR()`, the `EMA_RSI_ST_USE_SUPERTREND` toggle and the `EMA_RSI_ST_SL_MODE=psar` option are deleted; **SuperTrend(10,3) is now the only directional gate and EMA21 the only base SL** (+ optional candle trail). Mirrored identically across the shared signal module ([strategy1_sar_ema_rsi.js](src/strategies/strategy1_sar_ema_rsi.js)), paper ([emaRsiStPaper.js](src/routes/emaRsiStPaper.js), canonical), live ([emaRsiStLive.js](src/routes/emaRsiStLive.js)) and backtest ([backtestEngine.js](src/services/backtestEngine.js)); the `sar*` trade-record columns and chart SAR overlay are removed. BB_RSI's own PSAR is untouched.
- **Added an opt-in EMA triple-stack gate (`EMA_RSI_ST_EMA_TRIPLE_STACK_ENABLED`, default OFF + `EMA_RSI_ST_EMA_FASTEST=9`).** When ON, the EMA alignment requires EMA9 > EMA20 > EMA50 (CE) / reverse (PE) instead of the 2-EMA cross — a stricter gate that drops the marginal near-flat cross-over entries that drove the chop losses (e.g. a 0.02-pt "cross" that lost −₹2,567). Lives in the shared `getSignal()`, so it applies to backtest/paper/replay/live/harness at once; `ema9AtEntry`/`ema9AtExit` are captured per trade when ON. **Ships dormant** — no behaviour change and the `/replay` baseline stays exact until you enable it. A/B it via `/replay` sim mode on recorded sessions before turning it on for paper/live.
- Settings → EMA_RSI_ST updated: section title → **EMA 20/50 + RSI + SuperTrend**; new **Triple-Stack EMA (9>20>50)** toggle + **EMA Fastest Period**; the **Use SuperTrend (vs PSAR)** toggle and **SL / Trail Source** select are gone (SuperTrend + EMA21 are now fixed).

### Settings: expose `EMA_RSI_ST_OPTION_EXPIRY_TYPE` in EMA_RSI_ST section

- **Surfaced the EMA_RSI_ST-only expiry type toggle (`weekly`/`monthly`) in Settings**, sitting next to the existing **EMA_RSI_ST Option Expiry (override)** field — mirroring how the common section pairs `OPTION_EXPIRY_OVERRIDE` with `OPTION_EXPIRY_TYPE`. The key was already read by `src/config/instrument.js` (per-mode `${MODE}_OPTION_EXPIRY_TYPE`) but had no UI control; blank inherits the common Expiry Type.

### Feature: EMA_RSI_ST choppy-day guard (`EMA_RSI_ST_MAX_CONSEC_LOSSES`)

- **Added a consecutive-loss circuit breaker that sits EMA_RSI_ST out for the rest of a choppy session.** After `EMA_RSI_ST_MAX_CONSEC_LOSSES` losing trades in a row, new EMA_RSI_ST entries are blocked until the session ends (or, in backtest, until the next trading day). Any **winning** trade resets the streak to 0 — so a day that chops early then trends is not permanently locked out. This targets range days where SuperTrend keeps flipping and the strategy dies by small stops, re-entering after each tiny loss (e.g. a −71/−71/−71/−133/−584 bleed → halt after 3 saves the tail).
- **Keyed on realized P&L sign, not exit reason** — a "Trail SL hit" can be a winner, so the streak counts `netPnl < 0` and resets on `netPnl > 0`. It uses an independent counter (`_chopConsecLosses`), separate from the legacy 3-loss escalating *pause* (which resets itself to 0 on 5-min and would otherwise make a count-based guard never fire).
- **Off by default (`0`)** — no behaviour change until set. Wired consistently into paper ([emaRsiStPaper.js](src/routes/emaRsiStPaper.js), canonical + drives `/replay`) at both entry gates, live ([emaRsiStLive.js](src/routes/emaRsiStLive.js)) at both entry gates, and the backtest engine ([backtestEngine.js](src/services/backtestEngine.js)). Counter resets at session start (paper/live) and per trading day (backtest). Exposed in Settings → EMA_RSI_ST as **Chop Guard (consec losses)** (INSTANT — no restart). Validate a value via `/replay` before running it live.

### Feature: EMA_RSI_ST per-trade points stop (`EMA_RSI_ST_STOP_LOSS_PTS`)

- **Added a spot-points catastrophic loss cap to EMA_RSI_ST, mirroring `BB_RSI_STOP_LOSS_PTS`.** Exit once spot moves `EMA_RSI_ST_STOP_LOSS_PTS` against entry. It's checked **before** the structural/trail SL, so it caps deep adverse excursions on trades whose prevHigh/prevLow stop sits wider than the cap (EMA_RSI_ST's initial stop is often 40–70 pts away, so a loosely-trailed loser could bleed past the cap before the trail fired). Points-based, so it behaves identically on spot-proxy replays.
- **Off by default (`0`)** — no behaviour change until set. Wired consistently into paper ([emaRsiStPaper.js](src/routes/emaRsiStPaper.js), canonical + drives `/replay`), live ([emaRsiStLive.js](src/routes/emaRsiStLive.js)), and the backtest engine ([backtestEngine.js](src/services/backtestEngine.js), folded into Rule 1 as the tighter-of-two stop). Exit reason: `SL (Npts)`. Arms the same-side SL cooldown like other SL hits. Exposed in Settings → EMA_RSI_ST as **Stop Loss (pts)** (INSTANT — no restart). Validate a value via `/replay` before running it live.

### Feature: Strategy guides show a live "as-per-settings" status panel

- **Each strategy guide (Docs → Documents) now opens with a "Live Configuration" panel that reflects this server's current Settings.** The documented **Default** columns in the tables below are unchanged — the new panel adds a per-feature **ENABLED / DISABLED** badge showing what's actually active right now (e.g. VIX filter, wick/VWAP/volume filters, premium gate, expiry-day-only, candle trail, ADX filter, per-strategy mode toggle). Live Orders renders as a tri-state: **DISABLED → DRY-RUN → LIVE · REAL ORDERS** (honouring the global `LIVE_HARNESS_DRY_RUN` kill-switch and each strategy's own `*_LIVE_DRY_RUN` override). The Application Setup guide gets a system panel (global gates + all five strategy master toggles).
- **How it works.** Each guide HTML carries a `<!--LIVE_STATUS_PANEL-->` marker; [docs.js](src/routes/docs.js) replaces it at serve-time, resolving each toggle from the live runtime config (`process.env`, kept in sync with `.env` by Settings) with the documented default as fallback — the same resolution the strategy code uses. Files without the marker (e.g. PDFs) are served unchanged. No new env keys or routes; the panel is regenerated on every page load, so it always matches Settings.

### Fix: Charges schedule corrected to current NSE / statutory rates (matches Zerodha)

- **Options exchange-transaction charge was 0.05%; the current NSE rate is 0.03553% of premium turnover.** This single stale rate (plus its 18% GST knock-on) was inflating every option trade's modelled charges — e.g. a 4-trade EMA_RSI_ST session billed ₹336.06 vs Zerodha's ₹317.21. Corrected the default in [charges.js](src/utils/charges.js), [settings.js](src/routes/settings.js), and [README.md](README.md). Futures exchange txn likewise corrected 0.002% → 0.00183%.
- **GST base now includes SEBI charges** (`18% × (brokerage + exchange txn + SEBI)`), per the exchange schedule — previously SEBI was omitted from the GST base.
- **Exchange txn is no longer broker-specific.** It's an NSE charge, identical for every broker, so the hard-coded Fyers override (0.0445%) was removed — BB_RSI / PA / ORB / Straddle now use the same env-driven NSE rate as EMA_RSI_ST. STT (0.15% options / 0.05% futures), SEBI (₹10/cr), stamp duty (0.003%) and flat brokerage (₹20/order) were already correct and are unchanged.
- **Contract-note report now derives gross from the trade prices** (`gross = (sell − buy) × qty`) and `net = gross − charges`, the way a broker contract note does — instead of reading back the stored net and adding charges. This keeps the Gross column and the charges breakdown self-consistent after a rate change and makes the note match Zerodha's calculator exactly. For a trade booked at the current rates this net equals the stored P&L; trades booked **before** this fix keep their stored (higher-charge) dashboard P&L, so the note will read slightly better than the dashboard for those — re-run via `/replay` in current-settings mode to see them fully recomputed.
- **Note:** these are *defaults*. If a value for any of these keys is already persisted in the server environment (from a prior Settings save), update it in Settings → Charges so the new rate takes effect.

### Fix: Responsive layout on 13" laptops (Dashboard login button + Settings values)

- **Dashboard cards (broker connections, strategy charts) were cut off on the right on narrower desktops (e.g. 13" MacBook ~1440px), hiding the broker Login buttons.** Root cause: `.main-content` is a flex item but only got `min-width:0` inside the mobile (`≤768px`) block. On every wider screen it kept the flex default `min-width:auto`, so it **grew wider than the viewport** to fit its widest multi-column grid, and `body{overflow-x:hidden}` clipped the overflowing right edge (unreachable — couldn't even scroll to it). Zooming out only appeared to help because it shrank everything below the overflow point.
- **Fix.** Added `min-width:0` to the base `.main-content` rule in [sharedNav.js](src/utils/sharedNav.js) so the content column stays pinned to the viewport width on all pages and the inner responsive grids reflow instead of overflowing. Also made the dashboard grid items (`.mm-grid`/`.da-grid`/`.ts-grid` children) shrink-safe, and added a laptop/small-desktop breakpoint (`≤1200px`) that stacks the broker + strategy rows and wraps `.brk-row` so the login button drops to its own line ([app.js](src/app.js)). On Settings the `pattern-grid` collapses to one column and inputs get more room ([settings.js](src/routes/settings.js)). The 32" monitor and phone layouts are unchanged. CSS only — no env keys or routes.

### Feature: Contract-note Report (gross / charges breakdown / net P&L) on History + Replay

- **New "📄 Report" button on every Paper Trade History page (BB_RSI / EMA_RSI_ST / ORB, plus PA / Straddle).** It opens a broker-style **contract note** in a popup: a per-trade table (segment · exchange · buy price · sell price · qty · gross profit), then **Total gross profit / Total charges / Net P&L**, then a **Charges breakdown** (Brokerage, Exchange txn charge, Stamp duty, STT, GST, SEBI). Two scopes: a per-day **Report** button on each session card, and a top-bar **Report** button for all sessions combined.
- **Same Report on the Replay page** — a per-session **Report** under each replayed session's trades, a **Report (all)** button covering the whole range run, and a Report on the single-session result.
- **Export PDF** — the popup has an Export PDF button that opens a clean print view (Save as PDF) of the contract note.
- **Numbers match the dashboard.** Charges use the same canonical `calcCharges()` the engines use (broker schedule per strategy — EMA_RSI_ST = Zerodha rates, others = Fyers), and **Net P&L is anchored to the stored trade P&L**, so the report total equals the P&L shown everywhere; gross is derived as `net + charges`. Slippage / bid-ask spread is not modelled (same as paper/live). New shared module [contractNote.js](src/utils/contractNote.js); wired through [paperHistoryUI.js](src/utils/paperHistoryUI.js) and [replay.js](src/routes/replay.js). No new env keys or routes — the note is built client-side from data already on the page.

### Change: BB_RSI — BB re-entry stop is now per-tick (band touch), not candle-close

- **BB re-entry exits the instant spot crosses back through the band.** The `BB_RSI_BB_REENTRY_EXIT` stop previously only evaluated on 5-min candle **close** (`close > BB.lower` for PE / `close < BB.upper` for CE). On a one-candle V-reversal that let the bar print far past the band before exiting — e.g. the 2026-06-03 12:05 PE gave back to a 23236 close (−65.75 spot pts) when the band sat near 23195. The stop is now checked **per-tick** against the band fixed at the bar's start (from completed candles), so it exits at the band line. Applies to BB_RSI **paper + live** (canonical paper logic); **backtest** mirrors it via the bar's adverse extreme vs the band, exiting at the band level (profit-lock still takes priority within a bar). Same `BB_RSI_BB_REENTRY_EXIT` gate (default on); the candle-close check is kept as a backstop. New helper `bbLevels()` in [bb_rsi.js](src/strategies/bb_rsi.js).
- **Arming guard so a fresh entry at the band isn't whipsawed out.** The per-tick exit above can stop a trade taken right at the band on an immediate noise wick — on 2026-06-03 it flipped the 10:15 PE from a +₹445 profit-lock winner to a −₹376 loss by exiting 27s after entry (entered only 8 pts below the band). The exit now **arms only once the breakout has extended ≥ `BB_RSI_BB_REENTRY_ARM_PTS(10)` past the band** (tracks max favourable penetration per position); before that, band touches are ignored. The 12:05 protection is unaffected (it was 30+ pts past the band, armed immediately). On the recorded 2026-06-03 session this keeps the 12:05 save while restoring the 10:15 winner. New env key `BB_RSI_BB_REENTRY_ARM_PTS` (Settings → BB_RSI; `0` = arm immediately, i.e. old behaviour).
- **BB_RSI chart hover time fixed.** The crosshair time label defaulted to UTC (a 12:25 IST bar showed `06:55`). Added `localization.timeFormatter` to the bb_rsi-paper chart so the hover time matches the IST axis, mirroring the fix already in [replay.js](src/routes/replay.js). The same UTC-crosshair bug still exists in the other chart routes (EMA_RSI_ST/PA/ORB/straddle paper+live) — not yet patched.

### Change: Dashboard — hide controls & broker cards while a trade is running

- **Distraction-free Dashboard during active trading.** While any strategy is running (paper or live), the Dashboard now hides the top-bar action buttons (Start All (Harness) / Start All (Paper) / Reset Token), the schedule/cache pills (Expiry / Holiday / Candle cache), and the Fyers/Zerodha broker connection cards (balance, status, Login buttons). These reappear once everything is idle.
- **Always-on running indicator.** A status badge stays visible while active — the existing mode-specific badges (LIVE ACTIVE / BB_RSI LIVE / PA LIVE / ORB PAPER / STRADDLE PAPER) plus a new generic **TRADE ACTIVE** badge that covers the remaining states (EMA_RSI_ST/BB_RSI/PA paper, ORB/Straddle live) so you always know a trade is on.

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

- **Multiple harnesses at once.** The live harness was a process-wide singleton — only one strategy's harness could be installed at a time, so "Start All (Harness)" actually installed EMA_RSI_ST and then **409'd BB_RSI + ORB** ("already installed"). The harness is now a per-mode registry: each strategy registers its own `notify` order hooks keyed by mode and filters payloads by its `modeTag`, so EMA_RSI_ST / BB_RSI / ORB / PA harnesses run **concurrently without colliding**. Re-installing the *same* mode still throws. (`notify.js` now holds a `Map` of hook-sets instead of a single pair.)
- **Harness event log persists across restarts.** The "Recent harness events" ring buffer is now written to `~/trading-data/.harness_events.json` (debounced) and reloaded on boot, so a deploy / PM2 restart no longer wipes it to `[]`. Events are tagged with their mode; each harness's status panel shows only its own events.

### Change: EMA_RSI_ST SL — breakeven removed, candle-trail overlay added, `candle` mode dropped

- **Breakeven removed.** `BREAKEVEN_PTS` is gone from the EMA_RSI_ST settings page and from all three engines (paper / live / backtest). It was inert in `ema`/`psar` mode anyway (only ran in the old `candle` mode), so removing it changes nothing for current `ema`-mode sessions.
- **`EMA_RSI_ST_SL_MODE` now `ema | psar`** (was `candle | psar | ema`, default `candle`). New default is **`ema`** — the trail follows EMA21 and a candle touching back EMA21 is an explicit exit; `psar` trails Parabolic SAR with a flip-exit.
- **New optional candle-trail overlay** (`EMA_RSI_ST_CANDLE_TRAIL_ENABLED`, default **OFF**, + `EMA_RSI_ST_CANDLE_TRAIL_BARS`, default 2). When ON, each candle close the stop is set to whichever is **tighter** (closer to price) — the EMA/PSAR line or the N-bar low (CE) / high (PE). It can only pull the stop closer (banks more of a winner), never loosens it. Both keys are INSTANT (read live from `process.env`, no restart). Mirrors PA's `PA_CANDLE_TRAIL_*`.
- **Dead key removed:** `EMA_RSI_ST_OPTION_EXPIRY_TYPE` (nothing read it) is dropped from the Settings UI.
- UI trail card + start-logs now show the active trail source (e.g. `EMA21 + 2-bar low`) instead of the old "Prev-candle low / Breakeven+" text.

### Fix: BB_RSI backtest enters on the signal bar's close (matches paper)

- **Bug:** the bb_rsi backtest queued each signal and entered on the **next candle's open**, while paper (the canonical engine) enters immediately at the **signal bar's close**. That one-bar shift moved every stop-loss reference, which changed which trades hit Profit-lock vs BB-re-entry, which changed the re-entries after them — so the backtest's trade list diverged from paper's for the same day/settings.
- **Fix:** the backtest now creates the position at `candle.close` on the bar the signal fires (same as `bbRsiPaper.onCandleClose` → enter at `bar.close`); the `pendingSignal` / next-bar-open machinery is removed. Trade *entries* now line up with paper. **Note:** rupee P&L still won't match paper exactly — the backtest has only spot candles, so it prices options synthetically (`δ=0.55, θ=₹10/day`) and approximates the per-tick exits with bar high/low. For tick-accurate reproduction of a recorded paper session, use **Replay**.

### Change: Settings-changes history capped at 3 days

- **Settings audit retention:** the **Trade Logs → Checkpoints & Settings Changes** tab (`settings-audit.jsonl`) now keeps only the **last 3 days** of changes (`SETTINGS_AUDIT_RETAIN_DAYS=3`). Older entries are pruned from the file on every settings save and are never returned/shown — the list was growing unbounded (458 rows). No effect on per-day trade JSONL checkpoints.

### Feature: Dashboard "Start All (Harness)" one-click button

- New top-bar button (left of **Start All (Paper)**) that starts every Live (Harness) mode in one click — EMA_RSI_ST + BB_RSI + ORB (each gated by its `*_MODE_ENABLED`). Fires the `*-live-harness/start` routes, which wrap Paper so **LIVE = PAPER by construction** and respect the global `LIVE_HARNESS_DRY_RUN` flag (no real orders while DRY-RUN is on). Avoids visiting each strategy's Live (Harness) page separately. The existing **Start All (Live)** button still fires the legacy standalone `*-live` engines.

### Fix: EMA_RSI_ST + BB_RSI skip pre-market/pre-open candles (SuperTrend/SAR now match Kite)

- **Bug:** the tick→candle builders created candles from **pre-market ticks** — flat filler bars (~08:25–09:10) plus the **09:00 pre-open auction bar** (a wild wide-range print, e.g. a 250-pt range with a junk low). These polluted the path-dependent indicators (SuperTrend, SAR): the pre-open bar flipped SuperTrend bullish at 09:00 and pinned the support band a few points too high, causing a **premature bearish flip at 09:40** when the real flip (per Kite/TradingView) was ~11:45. Once flipped, the bot stayed on the wrong trend all midday.
- **Fix (candle hygiene):**
  - **Tick builders** now **only build candles from 09:15 IST** (NSE regular-session open), gated on the candle bucket's own IST time so it's correct in live **and** replay/sim. Applied to **EMA_RSI_ST** (paper + live, fixed `_MKT_OPEN_MINS`) and **BB_RSI** (paper + live, via shared `isPreMarketBucket()` in `tradeUtils`). EMA_RSI_ST/BB_RSI replay also benefit (recorded ticks re-run through the fixed builder).
  - **Historical fetch** (`backtestEngine.fetchCandles`) now filters to regular session (09:15 ≤ IST < 15:30), so the **warmup preload + backtest** candle sets are consistent with the live chart. Defensive no-op when the feed is already 09:15+.
- Verified the bot's SuperTrend formula + Wilder ATR already match TradingView/Kite exactly — same candles in → same SuperTrend out; the divergence was purely the extra pre-open candles.
- **PA / ORB / Straddle** tick builders still ingest pre-market candles (same latent issue) — left unchanged for now since they don't use SuperTrend and ORB's opening range is candle-boundary sensitive. The shared `isPreMarketBucket()` gate can be dropped into their `onTick` if wanted.

### EMA_RSI_ST entry redefined to EMA20/EMA50 crossover gate + SuperTrend line coloured green/red

- **EMA_RSI_ST entry is now an EMA20-vs-EMA50 alignment gate** (close-based, periods via new `EMA_RSI_ST_EMA_FAST`=20 / `EMA_RSI_ST_EMA_SLOW`=50). Entry fires only when **all 3** are true:
  - **CE**: EMA20 **above** EMA50 · RSI(14) in the CE band (`RSI_CE_MIN`..`RSI_CE_MAX`) · trend source **GREEN** (SAR below price, or SuperTrend bullish when `EMA_RSI_ST_USE_SUPERTREND=true`).
  - **PE**: EMA20 **below** EMA50 · RSI in the PE band · trend source **RED**.
  - This **replaces** the old "price touches EMA21" gate and **removes** `EMA_RSI_ST_ENTRY_REQUIRE_CROSS` / `EMA_RSI_ST_ENTRY_CROSS_TOLERANCE` (obsolete). **Stop-loss is unchanged** (prev-candle low/high, trailed). `EMA21(OHLC4)` is still computed for the `ema` SL mode + the trade-record snapshot, but is no longer an entry input.
- **Chart**: the EMA_RSI_ST chart now draws **EMA20 (gold) + EMA50 (blue)** lines (was a single EMA21). EMA20/EMA50 values are recorded per trade in the JSON + daily JSONL (`ema20AtEntry`/`ema50AtEntry`/`ema20AtExit`/`ema50AtExit`).
- **SuperTrend line is now trend-coloured GREEN (bullish) / RED (bearish)** on the EMA_RSI_ST, BB_RSI **and** Replay charts (was solid amber). The chart-data payload carries `trend` per SuperTrend point and the client colours each segment accordingly.
- **BB_RSI entry already honoured `BB_RSI_USE_SUPERTREND`** (PSAR vs SuperTrend) in paper/live/backtest — no logic change; only the chart line colouring was updated.

### SuperTrend(10,3) trend confirmation for EMA_RSI_ST & BB_RSI (toggle vs PSAR) + ADX on BB_RSI chart

- **New `EMA_RSI_ST_USE_SUPERTREND` / `BB_RSI_USE_SUPERTREND` toggles** (default off → PSAR, current behaviour). When ON, **SuperTrend(10,3)** replaces Parabolic SAR as the directional entry confirmation. The two are **mutually exclusive** — exactly one trend source is active. Period/multiplier configurable via `{EMA_RSI_ST,BB_RSI}_SUPERTREND_PERIOD` (10) / `_MULT` (3). All exposed in the Settings UI under each strategy.
  - **EMA_RSI_ST**: SuperTrend swaps SAR's "which side is the trend on?" role; the SL seed (prev-candle low/high) is unchanged.
  - **BB_RSI**: SuperTrend takes over the directional confirmation, the **entry SL line**, and the **candle-close trend-flip exit** (the `isPSARFlip` exit becomes a unified `isTrendFlip` that follows the active source). Profit-lock / hard-stop / BB-reentry exits unchanged.
  - SuperTrend is built on the `technicalindicators` ATR (the package has no SuperTrend), mirroring how EMA_RSI_ST already hand-rolls SAR. New shared helper [src/utils/supertrend.js](src/utils/supertrend.js).
- **Charts now plot the active trend source only** — PSAR dots when PSAR is on, a solid SuperTrend line when SuperTrend is on (EMA_RSI_ST + BB_RSI, paper + live).
- **BB_RSI chart now shows the ADX subplot** (it was computed only behind the `BB_RSI_ADX_ENABLED` filter and never charted). ADX(14) is now computed every candle and drawn on its own pane with the `BB_RSI_ADX_MIN` floor line.
- **Trade logs now capture all indicator values at entry AND exit** — added `supertrendAtEntry/Exit`, `stTrendAtEntry/Exit`, `trendSource` (EMA_RSI_ST + BB_RSI) and `adxAtEntry/Exit` (BB_RSI), plus an at-exit indicator snapshot (RSI/EMA21/SAR/BB/SuperTrend) recomputed on close.
- **Replay chart now renders SuperTrend + ADX too.** The Replay page reuses each strategy's `/status/chart-data` (so the payload already carried `supertrend`/`adx`), but its chart renderer only drew SAR/EMA/BB/RSI — it now draws the SuperTrend line and the ADX subplot, and the diagnostic trace switches its label to SuperTrend when that was the active source.

### Live (Harness) for EMA_RSI_ST, BB_RSI & ORB + interception fix

- **New `/ema_rsi_st-live-harness`, `/bb_rsi-live-harness`, `/orb-live-harness` routes** — each runs LIVE by wrapping its Paper engine (LIVE = PAPER by construction), mirroring the existing PA harness. EMA_RSI_ST routes orders via Zerodha; BB_RSI/ORB via Fyers. Gated by `LIVE_HARNESS_DRY_RUN` (+ per-strategy `{EMA_RSI_ST,BB_RSI,ORB}_LIVE_DRY_RUN`) and shown via `UI_SHOW_{EMA_RSI_ST,BB_RSI,ORB}_LIVE_HARNESS` (default off). Only one harness can be installed at a time (process-wide lock).
- **Fixed live-harness order interception.** The harness reassigned `notify.notifyEntry/Exit`, but every paper module destructures those at `require` time, so the reassignment never reached them — the order branch was a silent no-op even with `LIVE_HARNESS_DRY_RUN=false`. `notify.js` now invokes registered order hooks from *inside* `notifyEntry/notifyExit` (before any Telegram gating), and `liveHarness` registers via `setOrderHooks`/`clearOrderHooks`. This fixes the PA harness too.
- **Wired Zerodha dispatch** in `liveHarness._placeOrder` (previously threw "not yet wired"), enabling the EMA_RSI_ST harness to place real orders.

### Cache Files — per-strategy tags + filtered Delete All

- **Replay groups (Replay Trades / Replay Trades (Sim) / Replay Cache) now show a Strategy badge and Session date per file.** The Replay Cache files are sha1-hash-named, so previously there was no way to tell a BB_RSI cache from a EMA_RSI_ST one — "Delete All" wiped every strategy at once. The badge is derived from the filename for the replay outputs and from the embedded `mode` for hash-named cache files; the session date is read from the cached result (`date`, now stored) or recovered from a numeric `sessionId`.
- **New per-group Strategy filter dropdown.** Selecting e.g. BB_RSI scopes the listing, the "Download All", and the "Delete All" to just that strategy — so you can clear BB_RSI caches without touching EMA_RSI_ST. The confirm dialog spells out the scope. `tickReplay` now stamps `date` into every cached replay result so future caches are self-describing.

### BB_RSI — optional ADX trend filter (sit out choppy sessions)

- **New `BB_RSI_ADX_ENABLED` (toggle, default off) + `BB_RSI_ADX_MIN` (default 20).** When on, blocks **all** entries on a candle whose `ADX(14)` is below the floor — the engine sits out ranging/chop sessions. **Why:** replay showed the strategy's winning days are clean trends (price marches one way, all-PE or all-CE, big net +) while the losing days are choppy (price flip-flops, a mix of CE+PE that all fail). The entry rule is the same; the difference is trend vs chop. ADX is the standard trend/chop separator, so gating on it skips the bleed days at the source. Ships **off** so it can't change current behaviour until enabled. Engine computes ADX only when the toggle is on. `getSignal` result now carries `adx`. Settings + docs updated.

### BB_RSI — added a wide points hard stop alongside the profit lock (V6.2.1)

- **New `BB_RSI_STOP_LOSS_PTS` (default 30) — a per-tick catastrophic loss cap.** Exits if the trade moves N spot points against entry. Set **wide** so it never touches the normal small scalps; it only clips the deep adverse excursions on failed BB-break fades that previously bled to −100+ pts before the candle-close BB re-entry / PSAR flip could fire (the −₹1.9K/−₹2.4K losers). Points-based; reason `SL (Npts)`; arms the per-side SL cooldown. The profit lock (upside) and BB re-entry / PSAR flip are unchanged. Engine adds `hardStop()`; applied across paper/live/backtest/replay.
- **Note:** an earlier attempt (V6.3) that *replaced* the profit lock with a fixed-points trailing stop + a tight −20 hard stop was reverted — it was asymmetric (winners cut to breakeven, losers took the full stop). This change keeps the winning V6.2 behaviour and only caps the tail.

### BB_RSI — profit lock switched to spot-POINTS (V6.2)

- **Profit lock is now points-based, not ₹-based.** It tracks the favourable spot move since entry (PE = entry−price, CE = price−entry): once the peak favourable move ≥ `BB_RSI_PROFIT_LOCK_TRIGGER_PTS` (default 25), it exits when the move gives back below `BB_RSI_PROFIT_LOCK_PCT`% of the peak (ratchets up: peak 100pts → lock 50pts). **Why:** the old ₹-based lock (a) exited far too early on tiny ₹ peaks, and (b) read option P&L that is *fake* on spot-proxy replay sessions (a PE that fell 89 pts could show −₹68), so it never locked the real move. Points are real even on those sessions. Renamed key `BB_RSI_PROFIT_LOCK_TRIGGER` (₹) → `BB_RSI_PROFIT_LOCK_TRIGGER_PTS` (points). Exit label is now `Profit lock (Npts)`. Applied across paper/live/backtest.

### BB_RSI — BB re-entry (failed-breakout) exit (V6.1)

- **New candle-close exit: `BB_RSI_BB_REENTRY_EXIT` (default on).** After entry, if a candle closes **back inside** the Bollinger Band the breakout that triggered the trade has failed → exit immediately, rather than waiting for the slower PSAR flip. CE exits when `close < BB.upper`; PE exits when `close > BB.lower`. Targets the loss-bleed seen on replay (05-29 PE −₹3,236, 05-21 PE −₹1,455, 05-26 PE −₹1,695 all reversed back into the band before the PSAR flip fired). Order on candle close: profit lock (per-tick) → BB re-entry → PSAR flip → EOD. Toggleable so it can be A/B'd via `/replay`. Engine helper `bbRsiStrategy.bbReentryExit(window, side)`; applied across paper/live/backtest.

### BB_RSI — far-PSAR entry filter + profit lock (V6.1)

- **Profit lock replaces the R-multiple break-even.** The V6 break-even snap (`0.7 × initial risk`) almost never armed, because the no-clamp PSAR SL made "risk" huge (often 100–400 pts) — so winners round-tripped to the candle-close PSAR flip (replay showed a +₹650 peak giving back to −₹1,187). New per-tick **profit lock** works in P&L space: once peak open P&L ≥ `BB_RSI_PROFIT_LOCK_TRIGGER` (default ₹500), exit when open P&L falls below `BB_RSI_PROFIT_LOCK_PCT` (default 50) % of peak. The floor ratchets with the peak (peak ₹1000 → lock ₹500, peak ₹2000 → lock ₹1000), banking small bb_rsi profits while letting runners ride to the PSAR flip. Removed `BB_RSI_BREAKEVEN_TRIGGER_R` / `BB_RSI_BREAKEVEN_OFFSET_PTS`.
- **Far-PSAR entry filter.** New `BB_RSI_MAX_ENTRY_SL_PTS` (default 50): skip entries where PSAR sits farther than N pts from close. A freshly-flipped SAR can be 100s of pts away, producing uncapped-risk trades; this bounds entry risk without re-introducing a hard SL clamp.
- Exit reasons are now `Profit lock` / `PSAR flip` / `EOD square-off`. Applied across paper (canonical), live, backtest, replay; BB_RSI.md / README / docs updated.

### BB_RSI — simplified RSI entry + PSAR-flip exit (V6)

- **Entry RSI reduced to two keys.** Removed the `BB_RSI_RSI_CE_MAX` / `BB_RSI_RSI_PE_MIN` overbought/oversold caps. Entry is now simply CE: `RSI > BB_RSI_RSI_CE_THRESHOLD` (default raised **62 → 70**); PE: `RSI < BB_RSI_RSI_PE_THRESHOLD` (default lowered **42 → 40**). BB-break and PSAR-side conditions unchanged.
- **Exit is now PSAR-flip driven.** Initial SL = the PSAR value at entry (no min/max clamp). The position rides until the **PSAR flips on candle close** — that is the only normal exit; there is no intra-tick stop before break-even. The **break-even snap** (`BB_RSI_BREAKEVEN_TRIGGER_R`, default 0.7R) is retained as the sole hard intra-tick stop, fixed at entry ± offset. EOD square-off and daily-loss / max-trades / SL-pause guards are unchanged.
- **Removed the PSAR trail and prev-candle trail entirely**, along with the `BB_RSI_SL_USE_SAR`, `BB_RSI_MAX_SL_PTS`, and `BB_RSI_MIN_SL_PTS` settings (SL is always the PSAR value). Applied consistently across paper (canonical), live, and backtest. Updated BB_RSI.md / README.

### HISTORY — per-session "View chart" link into Replay

- **Each session card on all 5 paper history pages (EMA_RSI_ST/BB_RSI/PA/ORB/Straddle) now has a 📈 View chart link** that opens the candlestick chart + EMA/SAR/RSI + entry/exit trade markers for that exact session in Replay — no manual date/mode setup. The link deep-links `/replay?from=…&to=…&mode=…&run=1`; Replay prefills the date range + strategy mode and auto-runs. Reuses the existing Replay rendering (no duplicated chart code). Opens in a new tab.

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

### EMA_RSI_ST — opposite-side (flip) cooldown

- **New gate**: after any non-flip exit (Initial/Trail/Breakeven SL, option-stop, PSAR-flip exit, EMA touch-back exit), block entries on the **OPPOSITE side** for `EMA_RSI_ST_OPPOSITE_SIDE_COOLDOWN_CANDLES` × `TRADE_RESOLUTION` minutes. Prevents the bot from whipsawing CE→PE→CE in chop within minutes of an exit.
- **Skipped** for legitimate flips and end-of-day: `Opposite signal exit`, `EOD`/`Exit before day close`/`Auto-stop`/`Manual` exits do not trigger the cooldown.
- **Toggle**: `EMA_RSI_ST_OPPOSITE_SIDE_COOLDOWN_ENABLED` (default `true`). Candle count: `EMA_RSI_ST_OPPOSITE_SIDE_COOLDOWN_CANDLES` (default `3`).
- Applied identically across [emaRsiStPaper.js](src/routes/emaRsiStPaper.js) (canonical) / [emaRsiStLive.js](src/routes/emaRsiStLive.js) / [backtestEngine.js](src/services/backtestEngine.js). Settings UI fields added in [settings.js](src/routes/settings.js) (effect: SESSION restart).

### BB_RSI strategy — redefinition to BB break + PSAR + RSI (V5)

- **New entry logic** in [src/strategies/bb_rsi.js](src/strategies/bb_rsi.js) (`getSignal`), applied identically across Paper / Live / Backtest. Entry at candle close, all three true:
  - **CE**: close ≥ **BB upper** · **PSAR below close** · `RSI > BB_RSI_RSI_CE_THRESHOLD` (default raised 55 → **62**), blocked above `BB_RSI_RSI_CE_MAX(78)`.
  - **PE**: close ≤ **BB lower** · **PSAR above close** · `RSI < BB_RSI_RSI_PE_THRESHOLD` (default lowered 45 → **42**), blocked below `BB_RSI_RSI_PE_MIN(22)`.
- **Indicators kept**: Bollinger Bands `20 / 1`, RSI(14), PSAR `0.02 / 0.2`. PSAR side is now an entry confirmation (was exit-only).
- **Exit simplified** to SAR-based: initial prev-candle SL → **break-even snap** (`BB_RSI_BREAKEVEN_TRIGGER_R`) → **PSAR trailing** (tighten-only) → **PSAR flip** → bid-ask spread guard → EOD.
- **Resolution**: `BB_RSI_RESOLUTION` now offers **3 or 5-min** (was 5-only). Aggregation is resolution-agnostic via `getBucketStart`.
- **Removed** (code + Settings UI fields): tiered **% profit-trail** (`BB_RSI_TRAIL_START/PCT/TIERS/GRACE`), **time-stop** (`BB_RSI_TIME_STOP_CANDLES/FLAT_PTS`), **pause-override** (`BB_RSI_PAUSE_OVERRIDE_ENABLED/PTS`), **BB squeeze** (`BB_RSI_BB_SQUEEZE_FILTER` / `BB_RSI_BB_MIN_WIDTH_PCT`), **CPR-narrow** (`BB_RSI_CPR_NARROW_PCT` + `calcCPR`/`isNarrowCPR`), **approach** (`BB_RSI_REQUIRE_APPROACH`), **body-ratio** (`BB_RSI_MIN_BODY_RATIO`), **trend filter** (`BB_RSI_TREND_FILTER` + lookbacks), **activity filter** (`BB_RSI_ACTIVITY_FILTER` + ratio).
- **Guards kept**: VIX gate (`BB_RSI_VIX_*`), per-side SL cooldown (`BB_RSI_SL_PAUSE_CANDLES` / `BB_RSI_CONSEC_SL_EXTRA_PAUSE` / `BB_RSI_PER_SIDE_PAUSE`), `BB_RSI_MAX_DAILY_TRADES` / `BB_RSI_MAX_DAILY_LOSS`, prev-candle SL caps, trading window, `BB_RSI_EXPIRY_DAY_ONLY`, optional `BB_RSI_RSI_TURNING`.
- New authoritative spec: [BB_RSI.md](BB_RSI.md) (mirrors [EMA_RSI_ST.md](EMA_RSI_ST.md)). Files touched: [bb_rsi.js](src/strategies/bb_rsi.js), [bbRsiPaper.js](src/routes/bbRsiPaper.js), [bbRsiLive.js](src/routes/bbRsiLive.js), [bbRsiBacktest.js](src/routes/bbRsiBacktest.js), [settings.js](src/routes/settings.js).

### EMA_RSI_ST strategy — complete entry/exit redefinition (EMA21 + RSI + SAR)

- **New decision logic** in [src/strategies/strategy1_sar_ema_rsi.js](src/strategies/strategy1_sar_ema_rsi.js) (`getSignal`), applied identically across all 5 EMA_RSI_ST modes (Backtest, Paper, Live, Replay, Live Harness) since they all call it. Entry (intra-candle, all 3 true):
  - **CE**: `RSI(14) > RSI_CE_MIN` and `< RSI_CE_MAX` (overbought guard) · price at/above **EMA21 (OHLC4)** (already-above OR crossing up) · SAR below price.
  - **PE**: mirror — `RSI < RSI_PE_MAX` and `> RSI_PE_MIN` (oversold guard) · price at/below EMA21 · SAR above price.
- **Stop / exit** is now a **previous-candle trailing stop**: initial SL = the prior completed candle's low (CE) / high (PE); each candle close tightens SL to that candle's low/high (tighten-only). Exits: prev-candle SL · breakeven (`BREAKEVEN_PTS` → SL to entry) · **option-premium stop** (`OPT_STOP_PCT`, now actually wired into the exit check in Paper + Live, previously log-only) · opposite signal · **exit-before-close** (new `EMA_RSI_ST_EOD_EXIT_TIME`, default 15:15) · EOD auto-stop.
- **Same-side SL cooldown** (new `EMA_RSI_ST_SL_PAUSE_CANDLES`, default 3): after an SL / option-stop hit on a side, new entries on that side are blocked for N candles (per-side, mirrors BB_RSI).
- **RSI overbought/oversold guards** (new `RSI_CE_MAX`=80, `RSI_PE_MIN`=20): don't chase exhausted moves.
- **Resolution**: `TRADE_RESOLUTION` now offers **3 / 5 / 15-min** (logic is resolution-agnostic).
- **Removed** from EMA_RSI_ST: EMA9 touch, EMA30 trend gate, ADX filter, candle-body filter, SAR-distance gates, Logic-3 SAR-lag overrides, STRONG/MARGINAL strength tiers (entry is always intra-candle now), tiered (T1/T2/T3) trailing, hybrid initial-SL cap, and the 50% candle rule. The corresponding Settings fields were removed; new fields (RSI bands, breakeven, option-stop, cooldown, exit-before-close) added.
- **Guards kept**: VIX gate (`VIX_FILTER_ENABLED` / `VIX_MAX_ENTRY`), `MAX_DAILY_LOSS`, `MAX_DAILY_TRADES`, trading window, `TRADE_EXPIRY_DAY_ONLY`, EMA_RSI_ST expiry override/type, `EMA_RSI_ST_LIVE_ENABLED` / `EMA_RSI_ST_LIVE_DRY_RUN`.
- Files touched: [strategy1_sar_ema_rsi.js](src/strategies/strategy1_sar_ema_rsi.js), [backtestEngine.js](src/services/backtestEngine.js), [emaRsiStPaper.js](src/routes/emaRsiStPaper.js), [emaRsiStLive.js](src/routes/emaRsiStLive.js), [settings.js](src/routes/settings.js). Replay + Live Harness inherit via the paper/live engines (no duplicated logic).

### Paper Trade History — unified UI across all 5 strategies + server-side Daily Data Files pagination

- **New shared builder [src/utils/paperHistoryUI.js](src/utils/paperHistoryUI.js)** reproduces the canonical BB_RSI history page (top-bar actions, summary stat cards, Daily Data Files, Day View, full Analytics + Loss Analysis panels, session cards, trade-detail + JSONL-viewer modals). **ORB and Straddle history pages were rewritten to full parity** — they previously had only session cards + a 4-chart analytics strip and lacked Daily Data Files, Day View, Loss Analysis, the JSONL viewer, and per-date restore. New endpoints added to both: `GET /download/daily-files` (paginated), `GET /download/skips-all`, `GET /view/skips/:date`, `GET /view/trades/:date`, `DELETE /session/:index`, `POST /restore-session/:date`, `GET /reset`.
- **Daily Data Files table now paginates server-side** on all 5 strategies (BB_RSI/EMA_RSI_ST/PA/ORB/Straddle). The `/download/daily-files` endpoint accepts `?page=&pageSize=` and returns `{ rows, total, page, pageSize, totalPages }` (shared `dailyFilesPaginate()` helper); `pageSize=0` returns all rows (used by "Copy All Data"). Replaces the previous client-side `enhanceTable` pagination that loaded every date row up-front.
- **UI_THEME light toggle now honored on every history page.** BB_RSI/PA never set `data-theme` (always dark); the shared builder now emits `themeInitScript()` + `historyLightCSS()` (BB_RSI/PA inject them too), so all five follow the Settings theme toggle identically.
- **All 5 history pages now route through the shared builder** (`renderHistoryPage()`) — BB_RSI, EMA_RSI_ST, PA, ORB, and Straddle. ~4,300 lines of duplicated inline page HTML/JS deleted across the five routes; the page UI is now a single source of truth.
- **Generic filter + extra-analytics hooks** added so PA keeps its pattern-attribution features on the shared page: `cfg.filter` ({ field, label }) renders a top-bar dropdown that narrows session cards, summary stat cards, Day View, and Analytics by any per-trade field (PA uses `patternGroup`, derived from `entryReason`); `cfg.extraAnalyticsHTML`/`extraAnalyticsJS` inject PA's full-data "Pattern Breakdown" table (click a row to filter). Day View / Analytics read a shared `ACTIVE_TRADES` set so the filter flows through everywhere. `?filter=`/`?pattern=` URL param preselects a group.

### Live trading — per-strategy DRY-RUN override (staged real-money rollout)

- **`{STRATEGY}_LIVE_DRY_RUN` per-strategy overrides** added so live strategies can be graduated to real money independently. Previously `LIVE_HARNESS_DRY_RUN` was a single global switch — flipping it OFF made *every* enabled live strategy place real orders at once, so you couldn't run e.g. EMA_RSI_ST on real money while keeping ORB simulated.
- New shared gate [src/utils/liveDryRun.js](src/utils/liveDryRun.js): a strategy is dry-run if the **global** `LIVE_HARNESS_DRY_RUN` is on (forces all), **or** its own `EMA_RSI_ST_LIVE_DRY_RUN` / `ORB_LIVE_DRY_RUN` / `PA_LIVE_DRY_RUN` / `STRADDLE_LIVE_DRY_RUN` / `BB_RSI_LIVE_DRY_RUN` is on. Overrides can only **add** safety, never remove it. All default `false`, so behaviour is unchanged until explicitly set.
- Wired into [emaRsiStLive.js](src/routes/emaRsiStLive.js), [orbLive.js](src/routes/orbLive.js), [straddleLive.js](src/routes/straddleLive.js), [paLiveHarness.js](src/routes/paLiveHarness.js), [bbRsiLive.js](src/routes/bbRsiLive.js); all five toggles exposed in the [Settings UI](src/routes/settings.js). Example: `LIVE_HARNESS_DRY_RUN=false` + `ORB_LIVE_DRY_RUN=true` → EMA_RSI_ST places real orders while ORB stays logged-only.
- **BB_RSI Live previously had NO dry-run guard at all** (it placed Fyers orders directly regardless of any flag). It now honours the same gate — and since BB_RSI Live has no separate master-enable toggle, `BB_RSI_LIVE_DRY_RUN` (plus the global flag) is its primary safety switch. With the global flag at its default (on), BB_RSI Live is now simulated by default instead of placing real orders.

### Trade logging — uniform entry-context + MFE/MAE + exit VIX across all 5 strategies

- **Every strategy's trade record now captures the signal diagnostics it already computes at entry** but previously discarded ([src/routes/](src/routes/) paper + live for PA, ORB, Straddle, EMA_RSI_ST; BB_RSI already had entry context). PA logs `rsiAtEntry`/`adxAtEntry`/`adxRising`/`isTrending`/`patternAtEntry`/`srLevelAtEntry`; ORB logs `vwapAligned`/`volPass`/`wickPass`; EMA_RSI_ST logs `ema9AtEntry`/`ema9Slope`/`sarAtEntry`/`sarTrend`/`adxAtEntry`/`adxTrending`; Straddle already logged `trigger`/`bbWidth`/`bbWidthAvg`.
- **MFE/MAE excursion tracked per-tick on all 5** (max-favorable + max-adverse in spot pts and ₹; Straddle uses combined-premium swing + `maxSpotMovePts` since it's delta-neutral). BB_RSI gained MAE alongside its existing MFE.
- **`secsToMFE` / `secsToMAE`** — seconds from entry to the favorable peak / adverse trough, so "peaked early then bled out" is distinguishable from "slow grind" (the key signal for trail-start / grace tuning). Measured in each strategy's own tick clock (`simNow()` for the replayed paper engines, `Date.now()` for live / ORB / Straddle) so a replayed session reproduces identical values — preserves the "replay snap 1 == live recording" invariant.
- **`vixAtExit`** added to every trade record (read from the existing VIX cache — no new network poll), pairing with the existing `vixAtEntry`.
- **Pure additive logging** — no entry, exit, SL, trail, or fill logic changed on any strategy or mode; paper logic untouched. Within the active paper-trade data-collection window. Lets post-window analysis correlate how each engine reacted to the market conditions present at entry/exit without reconstructing them from raw ticks.

### Dashboard — fix P&L chart fill colour above zero

- **The cumulative/module chart fill now splits at the zero line.** Previously the area fill was a single colour keyed off the net total, so a net-negative chart painted the whole area red even where the line ran green above ₹0. The fill ([src/app.js](src/app.js)) is now a vertical gradient — green above the zero baseline, red below — matching the per-segment line colour.

### Dashboard — one global Paper/Live toggle for all charts

- **Replaced the six per-card Paper/Live toggles with a single top-bar toggle.** Each strategy chart (EMA_RSI_ST/BB_RSI/PA/ORB/Straddle) and the Cumulative P&L card carried its own Paper/Live switch; they're removed in favour of one square PAPER/LIVE toggle in the dashboard top-bar ([src/app.js](src/app.js)), defaulting to PAPER. Flipping it re-renders every module chart and the cumulative chart from the chosen source at once. Dead per-card toggle markup, click handlers, and CSS removed.
- **Top bar kept to a single line.** The title, toggle, and action buttons/pills no longer wrap to a second row — the bar stays one line and scrolls horizontally if it ever overflows.
- **The "Start All" quick-action now follows the same toggle.** The separate "▶ All Paper" / "▶ All Live" buttons collapse into one "▶ Start All (Paper/Live)" button that starts whichever mode the toggle selects (PAPER → all paper modes, LIVE → all live modes, with the existing live confirm prompt). The Paper↔Live mutual-lock poller is preserved — it now drives the single button (shows "● PAPER/LIVE ACTIVE" or "🔒 …locked" against the selected mode).

### Paper capital — broker investment pools replace per-strategy capital

- **Five per-strategy paper-capital settings collapsed into two broker-level pools.** `EMA_RSI_ST_PAPER_CAPITAL`, `BB_RSI_PAPER_CAPITAL`, `PA_PAPER_CAPITAL`, `ORB_PAPER_CAPITAL`, and `STRADDLE_PAPER_CAPITAL` are removed from Settings and replaced by `ZERODHA_INV_AMOUNT` (EMA_RSI_ST) and `FYERS_INV_AMOUNT` (BB_RSI + PA + ORB + Straddle), matching how each strategy is brokered ([src/routes/settings.js](src/routes/settings.js)). Each strategy now reads its broker pool as its starting capital; running capital is still `pool + all-time P&L`, so existing on-disk `totalPnl` is preserved (defaults unchanged at ₹100000).
- **Dashboard shows each broker pool's remaining balance.** The main dashboard's broker-connection rows ([src/app.js](src/app.js)) now display each pool inline — remaining = pool + summed all-time paper P&L of that broker's enabled strategies (Fyers row sums BB_RSI/PA/ORB/Straddle, Zerodha row = EMA_RSI_ST), read server-side from the `*_paper_trades.json` totals. The rows were also tightened to make room. The Real-Time Monitor ([src/routes/realtime.js](src/routes/realtime.js)) carries the same pools as a wallet strip above the strategy cards (computed client-side from the `totalPnl`/`capital` each `/status/data` already returns). Pools only appear when at least one strategy on that broker is enabled.
- Settings/display plumbing only — no paper decision/fill/exit logic or strategy params changed; capital is display-only (kill-switches read session P&L). The `*_LIVE_CAPITAL` fallbacks in [src/routes/orbLive.js](src/routes/orbLive.js) / [src/routes/straddleLive.js](src/routes/straddleLive.js) now fall back to `FYERS_INV_AMOUNT` instead of the removed paper keys.

### Replay — Cancel button for a running replay

- **A running replay can now be cancelled mid-session.** While a date-range batch (or single session) replays, a red **✕ Cancel** button appears next to the run button (in [src/routes/replay.js](src/routes/replay.js)). Clicking it POSTs `/replay/cancel`, which sets a flag the spot-tick streaming loop in [src/services/tickReplay.js](src/services/tickReplay.js) checks each tick — the loop stops early, runs `/stop` to square off cleanly, and returns `cancelled: true` so the replay-in-progress flag clears with no stuck state. The batch then halts before the next session and reports "🛑 Cancelled".
- Diagnostic/UI plumbing only — no paper decision/fill/exit logic, strategy params, or env changed (the cancel path reuses paper's own `/stop` squaring-off).

### Replay — fix absurd PnL when a trade enters before its first option tick

- **Replay no longer poisons entry LTP with the spot price.** When a strategy entered slightly before the recorded option timeline's first tick (e.g. EMA_RSI_ST entering at 09:36:16 while `NIFTY…23700CE`'s first recorded tick is 09:36:26), `_lookupNearest` in [src/services/tickReplay.js](src/services/tickReplay.js) returned `no_data`, so paper's 10s spot-proxy fallback set `optionEntryLtp` to the spot price (~100× the premium). Mixing that with a real exit premium produced six-figure-negative PnL (e.g. −₹1,529,787 on one trade), which then tripped `MAX_DAILY_LOSS` and suppressed every later entry (1 replayed trade vs 5 live).
- **Fix:** when `replayNow` precedes a freshly-subscribed symbol's first recorded tick, `_lookupNearest` now forward-fills that first tick — mirroring live, where the first option websocket tick after subscription fills `optionEntryLtp`. Entry LTP now matches the live recording's first-tick premium; mid-trade and exit lookups are unchanged (they always have a prior tick).
- Replay/diagnostic correctness only — no paper decision/fill/exit logic, strategy params, or env changed.

### Replay — fix "Baseline FAILED — No canonical paper-trade record found"

- **The baseline (live recording) now matches across all modes.** `_lookupCanonicalSession` in [src/services/tickReplay.js](src/services/tickReplay.js) compared `Date.parse(session.date)` against the intraday session-start timestamp within a **60-second** window. The catch: `session.date` is written two different ways — EMA_RSI_ST stores a date-only string (`"2026-05-21"`, parses to midnight UTC → hours off the window → never matched), while pa/bb_rsi/orb/straddle store a full ISO timestamp (`state.sessionStart`, which *was* within the window). So EMA_RSI_ST never matched and the others did. The matcher now normalises **either** form to a UTC calendar day and matches on that, with a tiebreak on the closest start instant when a day has multiple sessions — so all five modes match.
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

### EMA_RSI_ST Live — DRY-RUN harness gate

- **EMA_RSI_ST Live now honours `LIVE_HARNESS_DRY_RUN`.** Previously EMA_RSI_ST Live ([src/routes/emaRsiStLive.js](src/routes/emaRsiStLive.js)) called Zerodha directly the moment `EMA_RSI_ST_LIVE_ENABLED=true` — it had no dry-run safety net, unlike the Fyers strategies (PA/ORB/Straddle). All four real-order paths — market entry/exit (`placeMarketOrder`), hard SL-M placement (`placeHardSL`), trail modify (`updateHardSL`), and SL cancel (`cancelHardSL`) — are now gated: when `LIVE_HARNESS_DRY_RUN=true` (default) each logs the broker call it *would* make and returns a simulated success against a `DRYRUN-*` virtual order ID, placing no real order. The engine's position / hard-SL / trail / P&L bookkeeping runs end-to-end against virtual fills so decisions can be validated before flipping to real money. Fill-verification polling (`verifyOrderFill`) is skipped in dry-run (no real order to poll).
- **Visibility:** the `/ema_rsi_st-live/status` page shows a server-rendered DRY-RUN (amber) / LIVE (red) banner under the broker badges, the start-up log prints the active order mode, and `/ema_rsi_st-live/status/data` exposes a `dryRun` flag. No new env key or Settings toggle — reuses the existing `LIVE_HARNESS_DRY_RUN` switch already in Settings.
- Additive gating + logging only — no strategy decision/fill/exit logic touched; EMA_RSI_ST Paper untouched.

### Telegram — ORB + Straddle alert toggles + consolidated report coverage

- **Per-strategy toggles for ORB and Straddle.** `modeGroup()` in [src/utils/notify.js](src/utils/notify.js) previously had no ORB/Straddle branch, so their `ORB-*` / `STRADDLE-*` mode strings fell through to the `EMA_RSI_ST` default — meaning ORB/Straddle entry/exit/started/day-report alerts were silently controlled by the `TG_EMA_RSI_ST_*` toggles and couldn't be muted independently. Added `ORB` and `STRADDLE` groups (prefix-matched so the live `(DRY-RUN)` suffix still resolves) plus matching `modeLabel()` cases for clean message headers. New Settings toggles: `TG_{ORB,STRADDLE}_{STARTED,ENTRY,EXIT,DAYREPORT}` (all default `true`, preserving prior always-on behaviour). No `_SIGNALS` toggle — neither strategy emits candle-close signal alerts.
- **Consolidated EOD report now includes ORB + Straddle.** [src/utils/consolidatedEodReporter.js](src/utils/consolidatedEodReporter.js) read only the 6 EMA_RSI_ST/bb_rsi/PA files; added `orb_{paper,live}_trades.json` and `straddle_{paper,live}_trades.json` (10 sources total) and the two new `byMode` buckets. `notifyConsolidatedDayReport()` now renders all five strategy rows (column padding widened for `STRADDLE`).
- **Reports follow the strategy master toggles.** Every alert (`notifyStarted/Entry/Exit/Signal/DayReport`) and the consolidated report are now gated by `{GROUP}_MODE_ENABLED` via a new `isModeEnabled()` helper — a strategy disabled in Settings sends no alerts and is omitted from the consolidated report, regardless of its `TG_*` toggles.
- **Straddle counts now collapse legs to pairs.** Straddle persists one record per leg (CE/PE) sharing a `pairId` + combined `pairPnl`; the day report and consolidated report were counting each leg, so a winning pair showed as 1 win + 1 loss and the trade count was doubled. New `straddlePairStats()` helper (used by both reports) groups by `pairId` and tallies wins/losses on `pairPnl`, mirroring the Straddle history page. Net P&L was already correct (it came from `sessionPnl` / summed `pairPnl`); only counts and win-rate were affected.
- Additive notification wiring only — no strategy decision/fill/exit logic touched.

### Docs — Sync README.md + CLAUDE.md with current app

- **README.md** now reflects the five-strategy reality (EMA_RSI_ST / BB_RSI / PA / **ORB** / **Straddle**). Updated the architecture diagram, the modes table, the strategies section (new ORB and Straddle write-ups, PA breakeven trigger), the env-var tables (added every `ORB_*` / `STRADDLE_*` key with current defaults; corrected stale defaults for `MAX_DAILY_TRADES`, `BB_RSI_MAX_SL_PTS`, `BB_RSI_TRAIL_START`, `BB_RSI_TRAIL_TIERS`, `BB_RSI_MAX_DAILY_LOSS`, `PA_TRAIL_START`, `PA_TRAIL_TIERS`, `PA_CANDLE_TRAIL_BARS`, `PA_RSI_CAPS_ENABLED`), the routes section (ORB / Straddle / Replay / All-Backtest / paLiveHarness / paPatternBacktest), the persistence layout (per-day `ticks/`, `_replay_trades/`, `_replay_trades_sim/`; gap noted that `.active_orb_position.json` / `.active_straddle_position.json` don't exist yet), the menu-visibility / security tables, and the project structure tree.
- **CLAUDE.md** routes paragraph now lists the unified pages (Real-Time, Replay, All-Backtest, consolidation, tradeLogs) and adds a 4th step to the "wiring a new strategy" checklist — register with the shared monitors gated by `{STRATEGY}_MODE_ENABLED`. Persistent-data section now includes `ticks/` + `_replay_trades/` and calls out the ORB/Straddle position-persist gap. Added "Live order placement is double-gated" and "Tick recorder is the source of truth for Replay" guidance to the working-in-repo section.
- Pure docs sync — no code paths touched.

### Settings — Drop orphan PA_ADX_DIRECTIONAL row

- Removed the `PA_ADX_DIRECTIONAL` toggle from the PA section of the Settings UI ([src/routes/settings.js](src/routes/settings.js)). The row was advertising a directional ADX gate (require `+DI > -DI` for CE / `-DI > +DI` for PE) that the engine never actually enforced — no reader exists in [src/strategies/price_action.js](src/strategies/price_action.js). Removing the UI to stop misleading the operator; the gate itself can be added after the paper-trade data-collection window closes (~2026-06-02) without re-introducing UI drift.

### Replay — Date-range loop fix + pump speedup

- **Bug:** picking a multi-day range on the Replay page only ran the first session and never rendered a result. `renderRangeResult()` in [src/routes/replay.js](src/routes/replay.js) declared a local `const modeTag` that shadowed the outer `modeTag()` helper and called itself in its own initializer — a TDZ ReferenceError thrown on the first per-row "live partial render" tore down the orchestration loop before session 2 began. Renamed the local to `headerTagClass` so the outer helper resolves cleanly at line 1289.
- **Perf:** `harness.setWallClock()` in [src/services/tickReplay.js](src/services/tickReplay.js) is called once per pumped tick (~55k+ times per session) to keep `Date.now()` inside strategies pinned to the recorded timestamp. It used to reassign `Date.now`'s slot on every call, forcing V8 to deopt the global. Now installs a stable closure function once and only mutates the closure variable on the hot path. Measurable speedup on the date-range view; pure plumbing change — replay results are bit-identical.

### Real-Time Monitor — ORB + Straddle cards

- The Real-Time Monitor ([src/routes/realtime.js](src/routes/realtime.js)) now renders cards and rollup rows for **every strategy enabled in Settings** (EMA_RSI_ST, BB_RSI, PA, ORB, STRADDLE), not just the original three. Each card is gated by `{STRATEGY}_MODE_ENABLED` and disappears when the toggle is off.
- Field-shape differences are normalised client-side: ORB's `livePnl` / `tradesTaken` / `slSpot` / `currentOptLtp` / `log[]` and Straddle's CE+PE legs (`pos.ce` / `pos.pe`, `netDebit`, `combined`) now render correctly. Straddle gets a tailored position card showing both legs, net debit, target/stop net, and combined LTP.
- Card grid switched to `auto-fit, minmax(280px, 1fr)` so 4–5 strategies wrap responsively instead of overflowing the 3-column layout. ORB uses emerald, Straddle uses pink accent colours.
- Strategies without per-date JSONL endpoints (ORB, Straddle) show a disabled "— No Day Log —" placeholder instead of a "Copy Day Log" button that would 404.

---

## v4.5.0 — 5-Min EMA_RSI_ST Default, BB_RSI Pause Override, PA Reversal Fixes, Trade Logs Manager (2026-05-14)

### EMA_RSI_ST — Default Resolution Changed to 5-Min

- **`TRADE_RESOLUTION` default changed from `15` → `5`** ([src/routes/emaRsiStPaper.js](src/routes/emaRsiStPaper.js), [src/routes/emaRsiStLive.js](src/routes/emaRsiStLive.js), [src/strategies/strategy1_sar_ema_rsi.js](src/strategies/strategy1_sar_ema_rsi.js)).
- 15-min wasn't taking entries during the paper-trade data-collection window. The strategy itself is unchanged — all `TRADE_RES === 5` vs `>= 15` runtime branches are preserved, so flipping `TRADE_RESOLUTION=15` in `.env` (or via Settings UI) restores the prior behavior with no code change.
- Strategy header / description string updated to reflect the new default.

### EMA_RSI_ST — `EMA_RSI_ST_STRONG_ONLY` Toggle

- **`EMA_RSI_ST_STRONG_ONLY`** (default `false`) — when on, blocks **MARGINAL** signals on the **candle-close** entry path (intra-candle path was already STRONG-only, so this closes the asymmetry).
- Blocked entries are recorded to `skipLogger` with `gate: "strong_only"` for audit.
- Wired into both EMA_RSI_ST Paper and EMA_RSI_ST Live; surfaced in Settings UI.

### BB_RSI — Pause Override on Retest-and-Resume

- **`BB_RSI_PAUSE_OVERRIDE_ENABLED`** (default `false`) + **`BB_RSI_PAUSE_OVERRIDE_PTS`** (default `10`) ([src/routes/bbRsiPaper.js](src/routes/bbRsiPaper.js), [src/routes/bbRsiLive.js](src/routes/bbRsiLive.js)).
- After a per-side SL hit, bb_rsi normally cools down on that side for N candles. This blocked re-entry on the common pattern where price retests through the entry (hitting SL), then resumes in the original direction — the bot sat idle while the actual move played out.
- New gate: when a candle closes ≥ `BB_RSI_PAUSE_OVERRIDE_PTS` past the failed-entry spot in the original direction, the per-side pause is released early and the consecutive-SL counter for that side is reset. Genuine fails still cool down normally; only confirmed resumption clears the pause.
- New state field `_lastSLSpotBySide: { CE, PE }` records the spot at which each side last failed.

### BB_RSI — Trail / Breakeven Fixes

- **Trail uses PnL floor** instead of spot-delta model ([src/routes/bbRsiPaper.js](src/routes/bbRsiPaper.js), [src/routes/bbRsiLive.js](src/routes/bbRsiLive.js)) — fixes mismatches between the trail % the user configured and the rupee floor actually enforced.
- **Breakeven snap fires per-tick, not per-bar** — moves the breakeven jump out of the once-per-candle path so it can fire intra-bar once profit clears the threshold. Matches the rest of the tick-driven exit stack.

### BB_RSI — Per-Trade Context Logging (additive only)

- Each bb_rsi trade record now captures BB / RSI / trend context at entry and **MFE** (max-favorable excursion in points) over the life of the trade ([feat(bb_rsi): log BB/RSI/trend context + MFE per trade](src/routes/bbRsiPaper.js)).
- Pure logging — no entry, exit, SL, or trail logic changed. Feeds the active paper-trade data-collection schema.

### BB_RSI — `BB_RSI_CPR_NARROW_PCT` Now Editable in Settings

- `BB_RSI_CPR_NARROW_PCT` (CPR-narrow filter threshold) was code-only; now exposed as a Settings UI knob.

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

- **Checkpoint note prompt on Settings save** — every save can now be tagged with a one-line note ("rolled back PA RSI inversion", "tightened bb_rsi body ratio to 0.5", etc.), creating an audit trail of *why* a config changed.
- **Daily trade JSONL is now seeded with the current settings snapshot at session start** and re-appends on every Settings save during the session — so the JSONL log carries the exact config that produced each day's trades. No more "what was `BB_RSI_TRAIL_GRACE_SECS` set to on May 8?" guesswork.
- **Skip-log tab** added to the Trade Logs / Settings flow alongside trade entries.

### Sidebar — Per-Menu and Per-Submenu Visibility Toggles

- **Per-menu visibility toggles** ([feat(ui): per-menu visibility toggles in Settings](src/utils/sharedNav.js)) — hide entire mode sections (EMA_RSI_ST / BB_RSI / PA) from the sidebar without disabling the underlying engine.
- **Per-submenu visibility toggles** — finer-grained: hide individual links (e.g., hide "Backtest" but keep "Paper" and "Live") within a still-visible mode section.
- Driven by env vars + Settings UI; persists across restart. Lets you declutter the sidebar to match the workflow you actually use.

### Auth — Mobile-Friendly Login + Token Display + Pre-Start Verification

- **Mobile-friendly login flow** ([feat(auth): mobile-friendly login flow + pre-start token verification](src/routes/auth.js)) — the OAuth round-trip was previously redirecting back to a desktop-only landing page. Now responsive end-to-end.
- **Pre-start token verification** — before booting trading engines, a quick token-validity check runs; if Fyers/Zerodha auth is stale, the user is bounced to re-login *before* a position can open with a dead token.
- **Access token displayed with Copy button** after manual login — useful for cross-checking tokens against the broker's own session manager.
- **Fyers socket auth failure (code -15)** now bails out + sends a Telegram alert instead of silently retrying ([fix(socket): bail + alert on Fyers auth failure (code -15)](src/utils/socketManager.js)).

### Expiry / 0DTE Handling

- **EMA_RSI_ST blocks `/start` when the configured expiry == today** ([feat(swing): block start when configured expiry == today (0DTE warning)](src/routes/emaRsiStPaper.js)) — refuses to trade 0DTE for the EMA_RSI_ST strategy (gamma risk on intraday holding through expiry).
- **Per-mode option expiry override** ([feat(swing): per-mode option expiry override (avoid 0DTE on Tuesdays)](src/config/instrument.js)) — each mode (EMA_RSI_ST/BB_RSI/PA) can now set its own expiry override independent of the global setting. Useful when bb_rsi is fine on Tue weekly expiry but EMA_RSI_ST should roll to next Tue.
- **Dashboard handles 0DTE warning in Start-All flows** — All-Paper / All-Live now catches the 0DTE refusal per mode and surfaces it in the start-all error modal instead of silently skipping.
- **Red banner on dashboard** when a manual expiry-override session has ended (i.e., the override date is in the past) so a stale override doesn't quietly block trading.
- **Expiry calendar fix** — calendar was showing Mon dates instead of Tue (UTC shift bug); now correctly shows Tue weekly NIFTY expiries.
- **Settings expiry modal** no longer throws on a missing `year-title` element.

### Real-Time Monitor — Per-Card Action Buttons + Mini Activity Log

- **Per-card "Open Status" + "Copy Day Log" buttons** ([feat(realtime): per-card Open Status + Copy Day Log buttons](src/routes/realtime.js)) — each strategy card on `/realtime` now has direct jump-to-status and one-click day-log copy.
- **Copy Day Log copies raw entry + skip JSONL**, not the human-readable summary — useful for paste-into-LLM analysis.
- **Compact 5-line activity-log preview inside each EMA_RSI_ST / BB_RSI / PA card** ([feat(realtime): show recent activity log per strategy card](src/routes/realtime.js)) — at-a-glance confirmation the engines are alive when flat. Uses the existing `logs` / `logTotal` fields each `/status/data` endpoint already returns; no backend changes.
- **Layout fix** — `<a>` and `<button>` heights/centering aligned in the action row.

### Settings — EMA_RSI_ST Section Labels Renamed (15-min → 5-min)

- User-visible section headers, Telegram alert descriptions, and the section-summary modal title now read **5-min** instead of 15-min, matching the new `TRADE_RESOLUTION` default ([feat(ui): rename EMA_RSI_ST strategy labels 15-min → 5-min](src/routes/settings.js)). `SECTION_TO_MASTER` visibility map updated in lockstep (keyed by the exact title string, so any drift would silently break the per-section visibility toggle).

### Charts — Zoom Preserved, Pre-Market Junk Dropped, Strategy Overlays

- **Zoom preserved across refresh** on paper-trade charts ([fix(paper-charts): preserve zoom, drop pre-market junk, add strategy overlays](src/routes/)).
- **Pre-market junk dropped** — sub-09:15 ticks no longer pollute the candle chart x-axis.
- **Strategy overlays** added consistently across paper charts (matches what live charts already had).

### Activity Log — Copy Button

- **"Copy Log" button** ([feat(ui): add Copy Log button to activity log](src/routes/)) on the activity-log header of paLive, paPaper, emaRsiStLive, emaRsiStPaper. `navigator.clipboard` with textarea fallback. Mirrors the existing `copyTradeLog` pattern.

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
- **Three side-by-side cards** — EMA_RSI_ST / BB_RSI / PRICE ACTION — each showing:
  - RUNNING / STOPPED / OFFLINE badge
  - Open position card: side (CE/PE), symbol, qty, entry spot, entry option LTP, current option LTP, live spot, points moved, stop loss, entry time, **unrealised P&L with %**
  - "FLAT — no open position" placeholder when no trade is active
  - Today's stat tiles: Trades, Wins / Losses, Session P&L
  - Footer: live LTP, last tick time, tick count
- **Rollup table below** — one row per strategy plus a **TOTAL** row, columns: Strategy, Status, Open P&L (unrealised), Closed P&L (today), Trades, W / L, **Today Total (Open + Closed)**. Everything is today-only — no cumulative-across-all-sessions number on this page.
- **Read-only** — no Start / Stop / Exit buttons. Drill-down still happens on the dedicated `/ema_rsi_st-paper`, `/ema_rsi_st-live`, etc. pages.
- **Theme-aware** — respects the global `UI_THEME` setting (Day / Night view) like every other page; full light-mode overrides for cards, rollup, stats, and toggle. Positive / negative P&L values stay green / red in both themes via `!important` semantic color classes (so light-mode `.rollup td { color:#334155 }` rules can't override the P&L coloring by selector specificity).
- **No new backend aggregation** — the page polls each strategy's existing `/{mode}-{paper|live}/status/data` endpoint in parallel from the browser, so it always reads the same source the dedicated status pages already use. Zero risk of divergence; one normalised key handles `unrealisedPnl` (EMA_RSI_ST) vs `unrealised` (bb_rsi/PA).
- **Runs alongside live trading** — not in the sidebar's `blocked` list, so it's reachable while any live session is active (read-only, can't disturb broker state).

---

## v4.4.0 — Hybrid Initial SL Cap, Sync to Local, Restore Sessions, Live Paper-Parity (2026-04-27)

### EMA_RSI_ST — Hybrid Initial SL Cap

- **`EMA_RSI_ST_USE_PREV_CANDLE_SL`** (default `true`), **`EMA_RSI_ST_MAX_INITIAL_SL_PTS`** (default `50`), **`EMA_RSI_ST_MIN_INITIAL_SL_PTS`** (default `15`).
- Initial SL was previously always SAR-based (typically 100–130 pts wide on young trends), so a single losing trade could wipe out multiple winners. New logic in `_applyInitialSLCap()` takes the tightest of `[SAR, prev-candle structural low/high, entry ± MAX_PTS]` then floors at `MIN_PTS` to avoid suicide-tight SLs on doji bars.
- **Trail activation rescaled** — `TRAIL_ACTIVATE_PTS` now scales with the capped SL gap, so the env knob actually binds.
- **Wired into both EMA_RSI_ST Paper and EMA_RSI_ST Live** (`src/routes/emaRsiStPaper.js`, `src/routes/emaRsiStLive.js`); candle-close + intra-candle entry paths both go through the cap. Backtest is intentionally untouched during the paper-trade data-collection window.
- **Settings UI** exposes all 3 knobs in the EMA_RSI_ST section.
- New trade-record field `sarStopLoss` preserves the raw SAR distance for paper-vs-live + paper-vs-historical analysis.

### Live — Paper-Parity Sweep

- **`/ema_rsi_st-live`** — adds `pauseUntil` + `MAX_DAILY_TRADES` guards on the candle-close entry path (intra-candle path already had them); wires `skipLogger` + `logNearMiss` across signal=NONE / VIX / spread blocks (both candle-close + intra-candle); adds `strength` to `notifySignal` payload.
- **`/bb_rsi-live`** — ports `BB_RSI_TRAIL_GRACE_SECS` so first-tick noise spikes don't kill trades (matches paper); adds `entryTimeMs`; wires `skipLogger` + `logNearMiss` across the same gates.
- **`/pa-live`** — mirrors PA Paper's audit and skip-log wiring (strategy / VIX / spread gates), sharing the same `pa_paper_skips_*.jsonl` file as PA Paper.
- All three live engines now capture `signalStrength`, `vixAtEntry`, `entryHourIST`, `entryMinuteIST` at entry and surface them on the trade record at exit — feeding the active paper-trade data-collection schema.
- **Pure additive logging on PA strategy** — `result.filterAudit` (CE/PE × RSI / ADX / SR / Pattern) is populated on the no-signal path so JSONL skip logs capture *why* each bar produced no signal. `nearMissLog` now emits "🎯 NEAR-MISS" lines when a bar misses by exactly one filter. No threshold, pattern, RSI/ADX/SL, or signal logic changed.

### Dashboard — One-Click "Sync to Local"

- **`/sync/info`** + **`/sync/download-all`** — a Dashboard button now streams a `tar.gz` of `~/trading-data/` to the browser so the EC2 host's persistent trade data can be mirrored locally without SSH.
- Direction is **server → client only** (no upload path). Useful for local replay, off-EC2 backups, and cross-checking JSONL trade logs.

### Paper History — Restore Deleted Sessions

- **Restore button** next to each row in the Daily Data Files table on all 3 paper history pages (EMA_RSI_ST / BB_RSI / PA). Reads the daily JSONL for that IST date, dedupes trades against any sessions already present (by `entryBarTime` / `entryTime`), and rebuilds a session containing only the missing trades.
- Works because JSONL trade logs are append-only and untouched by Delete Session — recovered sessions are tagged `restoredFromJsonl: true`.
- **Idempotent** — re-running on a fully-present date returns "Nothing to restore." Endpoints refuse while paper is running (mirrors the delete handler).
- Backed by new helper `readDailyTrades(mode, date)` in `src/utils/tradeLogger.js`.

### Settings — Schema Cleanup + Re-grouping

- **Drift fixed** — settings UI was diverging from code: a few schema fields had no readers, several env vars used in code had no UI, and two unimported bb_rsi strategies still lingered in `src/strategies/`.
- Removed: `BACKTEST_GAMMA`, `ZERODHA_REDIRECT_URL` (no readers).
- Added: `PA_ENABLED`, `PA_OPT_STOP_PCT`, `GAP_THRESHOLD_PTS`, `LTP_STALE_FALLBACK_SEC`, `MAX_BID_ASK_SPREAD_PTS`, `TIME_STOP_CANDLES`, `TIME_STOP_FLAT_PTS` (now editable via UI).
- Removed from `IMMEDIATE_KEYS`: `BACKTEST_FROM`, `BACKTEST_TO`, `BACKTEST_GAMMA`.
- Deleted unused legacy strategies `src/strategies/bb_rsi_ema9_rsi.js` and `bb_rsi_ema9_rsi_v2.js` (active bb_rsi strategy is `bb_rsi.js`).
- **Expiry override moved** from the EMA_RSI_ST section to **Common — Instrument** in the Settings UI. Both `EXPIRY_OVERRIDE` and `EXPIRY_TYPE` are read by `src/config/instrument.js` for all 3 engines (EMA_RSI_ST / BB_RSI / PA), so the prior placement under EMA_RSI_ST was misleading. Pure UI re-grouping — keys, `.env`, and `IMMEDIATE_KEYS` classification unchanged.

### Consolidation — Date Normalization

- **`/consolidation` session date** normalized to `YYYY-MM-DD` so daily / monthly / yearly roll-ups are consistent across older sessions that previously stored dates in mixed formats. Equity curve and Day View both align on the canonical date format now.

### Startup — SSL-Cert Failure Hardening

- On SSL cert load failure (missing/invalid `certs/cert.pem` or `certs/key.pem`) the bootstrap now clears the Telegram crash-marker and skips the non-restart code path, so a misconfigured cert no longer triggers a phantom "recovered from crash" alert on the next boot.

### Misc UI / Bug Fixes

- **Eye-icon View button** on ema_rsi_st-paper-history rows is now wired through to the trade detail modal (parity with PA / BB_RSI).
- **Delete Session** on ema_rsi_st-paper-history now reloads cleanly (toast JS injected on delete) instead of leaving a half-rendered table.
- **Template-literal `\n` escape fix** on ema_rsi_st-paper-history rendering — long sessions no longer break copy-trade-log generation.

---

## v4.3.0 — Live Traded History, Per-Module Dashboard, Trade Guards, Audit Trails (2026-04-24)

### Live Traded History — Cross-Mode Live View

- **`/live-consolidation`** — unified live-trade history (EMA_RSI_ST Live + BB_RSI Live + PA Live), parallel to the existing `/consolidation` (paper). Same Daily/Monthly/Yearly roll-ups, filters, equity curve, and bulk copy.
- **Sidebar entry** under "🔴 Live Traded History" (sibling to "Paper Traded History").
- **Per-mode `/reset` endpoints** — `POST /ema_rsi_st-live/reset`, `POST /bb_rsi-live/reset`, `POST /pa-live/reset`. Reset buttons live on each live status page; gated when a session is active.
- **Toggle on dashboard** — the cumulative-P&L card switches between Paper and Live data sources, both feeding the same charts.

### Dashboard — Per-Module P&L Cards + Mutual Lock

- **Per-module cards** (EMA_RSI_ST / BB_RSI / PA) — each card has a Paper/Live toggle, trades, win-rate, total-P&L stats, and its own cumulative chart.
- **Per-module charts** colored red/green by P&L sign (not by paper/live colour).
- **Hover-only date labels** on dashboard charts (x-axis decluttered).
- **Mutual lock** between *Start All Paper* and *Start All Live* — once one is running, the other is disabled and pulses to indicate active state. Prevents accidentally double-running across modes.
- **Start-all failures surface in a modal** instead of silent reload.
- **Side-by-side broker rows** (Fyers + Zerodha on one row), compact pro layout.

### Per-Module VIX Thresholds

- **`BB_RSI_VIX_MAX_ENTRY`, `BB_RSI_VIX_STRONG_ONLY`, `PA_VIX_MAX_ENTRY`, `PA_VIX_STRONG_ONLY`** — BB_RSI and PA now have independent VIX thresholds (not just enable/disable). Each falls back to the EMA_RSI_ST values if unset, so existing configs stay compatible.
- Documented in `.env.example`; surfaced in Settings.

### Trade Guards — Bid-Ask Spread + Time-Stop

- **`MAX_BID_ASK_SPREAD_PTS`** (default `2`) — block entry if option bid-ask spread is wider than N points. Fails *open* if quotes unavailable so live entries don't freeze on a missing feed.
- **`TIME_STOP_CANDLES`** (default `4`) + **`TIME_STOP_FLAT_PTS`** (default `20`) — auto-exit a trade that has stayed flat (|PnL| < flatPts) for N candles, to bail out of pure theta-bleed.
- **PA-specific overrides**: `PA_TIME_STOP_CANDLES=3`, `PA_TIME_STOP_FLAT_PTS=10` (tighter, since PA SL is also tighter).
- Shared in `src/utils/tradeGuards.js`, used by all 3 paper + live engines.

### BB_RSI — Trend Filter

- **`BB_RSI_TREND_FILTER`** (default `true`) — block BB breakouts against the prevailing direction (no CE in a downtrend, no PE in an uptrend). Reduces whipsaws in choppy zones.
- Tunables: `BB_RSI_TREND_MOMENTUM_PCT=0.15`, `BB_RSI_TREND_MOMENTUM_LOOKBACK=5`, `BB_RSI_TREND_MID_SLOPE_LOOKBACK=3`. BB-mid slope + N-candle momentum jointly classify direction.

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

- **`src/utils/nearMissLog.js`** — every candle that *almost* triggered a trade (missed by exactly one filter) is logged with the failing filter name + detail. Wired into PA, EMA_RSI_ST, and BB_RSI paper modes.
- View live in `/logs` SSE feed. Quantifies the opportunity cost of each individual filter for tuning.

### Crash-Safe JSONL Trade Log

- **`src/utils/tradeLogger.js`** — every trade exit appended (POSIX `O_APPEND`, atomic per-line) to:
  - `~/trading-data/{ema_rsi_st|bb_rsi|pa}_paper_trades_log.jsonl` (cumulative)
  - `~/trading-data/trades/{ema_rsi_st|bb_rsi|pa}_paper_trades_YYYY-MM-DD.jsonl` (per-day)
- **Async fire-and-forget** — trade-exit hot path is no longer blocked by I/O.
- **Per-day skip + trade JSONL** is downloadable from history pages (per-date).
- Survives crashes — no data loss vs the old session JSON flush-on-exit.

### Consolidation — Day View Panel

- **Day View** table on `/consolidation` (and matching panels on per-mode paper/bb_rsi history) — chronological per-trade list with date, mode, entry/exit time, side, P&L; per-mode breakdown.
- **Pagination** on Day View on backtest + paper-history pages (no more 500-row scroll on long sessions).
- **Red/green tint** on P&L cells (cell background + row tint on consolidation, table-row tint on history).

### Sidebar — Accordion + Per-Feature Toggles

- **Accordion sections** (EMA_RSI_ST / BB_RSI / PA) — only one expanded at a time; collapses cleanly.
- **Per-feature menu toggles** (env-driven, hidden by default to declutter):
  - `UI_SHOW_SIMULATE` (default `false`) — show "Simulate" link under each mode
  - `UI_SHOW_COMPARE` (default `false`) — show "Compare" link
  - `UI_SHOW_TRACKER` (default `false`) — show "Tracker" under EMA_RSI_ST
- **Login Logs removed from sidebar** — moved to a top-bar button on the Settings page (still accessible at `/login-logs`).
- **Breadcrumbs** added to Settings, Monitor, Docs, P&L History, and Login Logs.
- **History button** on every paper status page (EMA_RSI_ST/BB_RSI/PA) → jumps to that mode's history.

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

- **Eye-icon View buttons** in ema_rsi_st-paper-history → trade-detail modal (parity with PA/bb_rsi).
- **Copy Trade Log + Delete Session** moved into the session header (before PnL) on all paper-history pages.
- **Compact dashboard** — per-module start rows + single-line broker rows.
- **Light-theme overrides** for all-backtest + docs pages.
- **All-backtest 401** now surfaces an error modal instead of silent refresh loop.

---

## v4.2.0 — Live Charts, Consolidation, P&L History, Telegram Restructure (2026-04-20)

### Live NIFTY Candlestick Charts

- **Chart on status pages** — live candlestick chart rendered on all paper + live status pages (EMA_RSI_ST / BB_RSI / PA), with real-time updates as candles close
- **Entry-logic overlays**: Bollinger Bands on bb_rsi charts, swing highs/lows on PA charts — makes it visual *why* the engine took (or skipped) a signal
- **Entry/exit markers** on every session chart (arrows + strike + P&L)
- **Click trade row → focus chart on that trade only** (zooms to entry–exit window). Click again or the reset icon to restore full session view
- **Chart zoom preserved across refresh**, even when focused on a trade — no more losing context every 10 seconds
- **Light-theme modal contrast** fixed for chart trade-detail popups
- **`CHART_ENABLED` toggle** in Settings to show/hide the chart globally

### Consolidation Page — Cross-Mode Trade History

- **`/consolidation`** — unified view flattening every trade across EMA_RSI_ST + BB_RSI + PA paper sessions
- **Roll-ups**: Daily / Monthly / Yearly P&L with per-mode breakdowns and equity curve
- **Filters**: mode, side (CE/PE), date range, symbol search
- **Bulk copy** (daily / weekly / monthly) + per-trade copy buttons
- Driven by the three `*_paper_trades.json` files — no extra persistence layer

### P&L History — Broker-Wise with FY Roll-up

- **`/pnl-history`** — consolidated realised P&L per broker (Kite + Fyers)
- **One-time past baseline** per broker (stored in `historical_pnl.json`) — set it once and forget; never FY-split, captures everything before the bot started
- **Live-bot overlay** — auto-computed from `live_trades.json` / `bb_rsi_live_trades.json` / `pa_live_trades.json`, grouped by Indian FY (Apr–Mar)
- **Grand total** per broker + across brokers (baseline + live)
- Live totals update automatically as trades close — no manual reconciliation

### Telegram — 17 Toggles + Master Gate + Consolidated EOD

- **Master gate `TG_ENABLED`** — single switch to mute all alerts without losing per-mode config
- **17 per-mode toggles**: `TG_{EMA_RSI_ST|BB_RSI|PA}_{STARTED|ENTRY|EXIT|SIGNALS|DAYREPORT}` + `TG_DAYREPORT_CONSOLIDATED`
- **Signal-skip alerts** per mode explain why a trade was/wasn't taken on candle close (when flat)
- **Consolidated EOD report** at 15:30 IST — one combined Telegram message across EMA_RSI_ST/BB_RSI/PA covering trades, wins/losses, win rate, net P&L (weekdays only, scheduled idempotently)
- **Per-mode day report on session stop** preserved as a separate toggle

### Settings UI — Bulk Paste + Restart

- **Bulk Update section** — paste `KEY=VALUE` pairs (or `KEY: VALUE`, quoted, `#` comments), previews keys to update, then applies all + restarts server with one button
- Sensitive keys (SECRET/TOKEN/ACCESS) are auto-ignored from bulk paste
- **Restart Server button** — graceful `process.exit(0)` via `POST /settings/restart`, leverages PM2/nodemon auto-restart. Active sessions stop cleanly before exit
- **Frozen (disabled) rows** for dependent fields — VIX params freeze when VIX filter off, entire bb_rsi section freezes when bb_rsi mode off

### BB_RSI V4 — Quality Filters + Trail Grace

- **Approach filter** (`BB_RSI_REQUIRE_APPROACH`) — block entry if prev candle was on opposite half of BB (first-touch breakouts often fade; require the market to be *approaching* the band)
- **Body-strength filter** (`BB_RSI_MIN_BODY_RATIO`) — require entry candle body to be at least N% of its range (rejects doji / long-wick breakouts signaling exhaustion)
- **Trail grace period** (`BB_RSI_TRAIL_GRACE_SECS`) — suppress trail-exit for first N seconds after entry so a first-tick spike + tiny pullback doesn't kill the trade; initial SL still active throughout
- Both V4 filters are env-toggleable and **exposed in Settings UI** (disabled by default to preserve prior behavior)

### Dashboard — Start-All + PA Panels

- **Start-All Paper** / **Start-All Live** buttons — kick off every enabled mode (EMA_RSI_ST + BB_RSI + PA) in one click, sequentially with per-mode confirmation
- **PA paper / live panels** on dashboard alongside EMA_RSI_ST + BB_RSI (previously only EMA_RSI_ST + BB_RSI were surfaced)
- Pickups hidden modes — if `BB_RSI_MODE_ENABLED=false` or `PA_MODE_ENABLED=false`, those panels and Start-All endpoints are excluded

### Session History — View Modal + Delete Session

- **View modal** on PA/BB_RSI history pages — full-session trade breakdown without leaving the list
- **Delete Session** button per session (EMA_RSI_ST + BB_RSI + PA) — removes one session from history with confirmation
- Per-session copy trade log preserved

### Simulator Fidelity

- **Historical replay warmup bumped 30 → 300 candles** (EMA_RSI_ST/PA) — indicators reach steady state before the first replay candle, eliminating cold-start signal anomalies
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

### Mode Rename: EMA_RSI_ST / BB_RSI / Price Action

- **All trading modes renamed** for consistency: "Live Trade" → EMA_RSI_ST Live, "Paper Trade" → EMA_RSI_ST Paper, "Backtest" → EMA_RSI_ST Backtest
- Route prefixes updated: `/trade` → `/ema_rsi_st-live`, `/paperTrade` → `/ema_rsi_st-paper`, `/backtest` → `/ema_rsi_st-backtest`, `/bb_rsi` → `/bb_rsi-live`
- Settings page section headers updated to EMA_RSI_ST / BB_RSI / PRICE ACTION
- Route files renamed: `trade.js` → `emaRsiStLive.js`, `paperTrade.js` → `emaRsiStPaper.js`, `backtest.js` → `emaRsiStBacktest.js`, `bb_rsi.js` → `bbRsiLive.js`, `priceActionLive.js` → `paLive.js`, `priceActionPaper.js` → `paPaper.js`, `priceActionBacktest.js` → `paBacktest.js`

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
- `entryReason` data tracked in bb_rsi/PA backtest and live trade engines

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
- Fix missing `fmtAna` function in PA and bb_rsi backtest analytics
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
- Available for all 3 modes: `/paperTrade/simulate`, `/bb_rsi-paper/simulate`, `/pa-paper/simulate`
- Historical date replay with 1-min candle tick replay for improved fidelity
- Resolution-aware simulated clock with correct timestamps and cooldowns

### Signal & Entry Improvements

- **ADX chop filter**: Skip entries when ADX < threshold (choppy market detection)
- **RSI overbought/oversold caps**: Block CE entries when RSI > 80, PE entries when RSI < 20
- **EMA30 filter toggle**: Optional medium-term trend gate (`EMA30_FILTER`)
- **Logic 3 CE override**: Captures lagging-SAR bullish entries that classic logic misses
- **Signal rejection breakdown**: Detailed analytics showing why signals were rejected (both trading and bb_rsi backtest)
- **BB squeeze filter**: Skip bb_rsi entries when Bollinger Bands are narrow (low volatility)
- **Consecutive SL escalation**: Widen SL after consecutive losses to avoid whipsaw
- **Rebalanced trailing**: Improved trail activation and gap defaults

### BB_RSI Strategy Enhancements

- **Tiered trailing profit**: Keep more as profit grows (₹500→55%, ₹1000→60%, ₹3000→70%, ₹5000→80%, ₹10000→90%)
- **PSAR trailing SL**: Only tightens, never widens; PSAR flip = immediate exit
- **SL source tracking**: Exit reasons now show whether SL was PSAR-based or Prev Candle-based
- **Previous candle SL** restored as default (replaced short-lived ATR-based SL experiment)
- **Default resolution changed from 3-min to 5-min** for bb_rsi mode
- **VIX filter fully decoupled**: Separate `BB_RSI_VIX_ENABLED` toggle independent of trading VIX
- **Look-ahead bias eliminated** in bb_rsi backtest — entries now on next candle open
- **SL recalculated relative to actual entry price**; gap-past entries skipped

### Capital Protection & Risk Management

- **Hard SL layer**: Additional absolute stop-loss as a safety net
- **Crash recovery**: Active positions persisted to disk (`~/trading-data/`); orphan detection + Telegram alert on restart
- **Staleness alerts**: Warns if data feed goes stale during active position
- **Health check button** on Settings page with status modal

### UI & Dashboard

- **Paper vs Backtest comparison page** (`/compare/trading`, `/compare/bb_rsi`) — side-by-side metrics: total trades, win rate, PnL, max drawdown, equity curve
- **EC2 instance health monitor** (`/monitor`) — real-time CPU, RAM, disk, load average, uptime charts
- **Analytics panels** on both trading and bb_rsi backtest pages — win/loss distribution, streak analysis, time-of-day performance
- **Detailed loss analytics** in bb_rsi backtest
- **Day view summary table** with copy buttons on backtest pages
- **Day/night theme toggle** — hand-crafted light theme with proper CSS (replaced initial filter-invert approach)
- **Collapsible accordion sections** on settings page
- **Eye icon summary modals** for trading & bb_rsi settings (with copy button)
- **Env key name display** after effect badge in settings UI
- **GitHub Actions deploy status widget** — floating chip in bottom-right, webhook-driven (`/deploy/webhook`)
- **Simulate links** added to sidebar navigation
- **Per-session delete button** and copy trade log in bb_rsi history
- **Chart.js colors now theme-aware** across all pages
- **Auto-refresh** on bb_rsi pages when returning from background tab

### Backtest & Analytics

- **Disk cache for candle data** (`~/trading-data/backtest_cache/`) — reduces Fyers API calls, 90-day auto-prune
- **Backtest-style analytics** added to paper trade screens (copy trade log, day view)
- **Candle pre-load extended** from 7 to 21 days to match backtest indicator depth
- **Default backtest range** set to current month (ignores `BACKTEST_FROM/TO` env vars)

### Configuration & Settings

- **Configurable entry start/end times** for both trading and bb_rsi
- **Configurable strategy thresholds** via Settings UI — dynamic trail activation, tighter defaults
- **STT charges updated to April 2026 rates** with configurable settings
- **Fyers-specific charge rates** — STT 0.15%, exchange txn 0.0445%
- **Expiry-day-only toggle** for both trading and bb_rsi modes
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
- Fix `vix.toFixed` crash in bb_rsi backtest by calling `lookupVix()`
- Fix live bb_rsi PSAR window alignment with paper/backtest (completed candles only)
- Fix option expiry date calculation edge cases
- Fix strike selection rounding
- Fix socket teardown when second mode starts; fix backoff loop
- Fix duplicate bar bug on bb_rsi paper UI
- Fix trailing profit lock — protects one step below peak instead of at peak (then reverted to lock at reached level)
- Fix manual entry SL when only 1 candle exists
- Fix `modalJS` isolation into separate script tag from trade data
- Fix zero-PnL trades counted as neutral, not losses
- Fix `candlesHeld` count after trail updates in backtest
- Fix bb_rsi paper/live option polling alignment to 1s
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

# Changelog

All notable changes to the Palani Andawar Trading Bot are documented in this file.

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

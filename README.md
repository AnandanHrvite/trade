# Palani Andawar Trading Bot

NIFTY options algorithmic trading bot with **13 independent strategies** (EMA_RSI_ST, BB_RSI, Price Action, ORB, EMA9+VWAP, Trend Pullback, GAPS, Trend Day Scalp, 3M Gap Fix Scalp, HA Scalp, OI Wall Fade, RSI Pivot ST, SIMPLE_9:30), dual-broker architecture (Fyers + Zerodha), background backtesting, paper trading, deterministic **tick-replay** of recorded sessions, after-hours simulation, live NIFTY candlestick charts, consolidated cross-mode analytics (paper + live), per-module dashboard P&L cards, **unified real-time monitor** (one screen for all strategies with a PAPER/LIVE toggle), crash-safe JSONL trade audit, near-miss filter audit, Telegram alerts, and a full web dashboard.

## Architecture

```
Fyers WebSocket (NIFTY50 spot ticks — single connection)
        │
   socketManager (singleton, multi-callback fan-out)
        │
   ┌─────┼──────────────┬──────────────┬───────────┐
   │     │              │              │           │
 EMA_RSI_ST (5/15-min)   BB_RSI (3/5-min)   Price Action   ORB
   │                    │                │           │
 ┌─┴─┐               ┌──┴──┐         ┌───┴──┐    ┌──┴──┐
 │   │               │     │         │      │    │     │
Live  Paper         Live  Paper     Live   Paper Live Paper
Zerodha  Sim        Fyers  Sim      Fyers   Sim  Fyers  Sim
```

All four strategies run **in parallel** on the same WebSocket — different candle resolutions, different brokers, independent risk controls. Within each strategy, Live ⊥ Paper (mutually exclusive); across strategies everything coexists.

## Modes

| Mode | Strategy | Timeframe | Broker | Route Prefix |
|------|----------|-----------|--------|-------------|
| **EMA_RSI_ST Live** | EMA 20/50 (+9 opt) + RSI + SuperTrend | 3 / 5 / 15-min via `TRADE_RESOLUTION` | Zerodha | `/ema_rsi_st-live` |
| **EMA_RSI_ST Paper** | EMA 20/50 (+9 opt) + RSI + SuperTrend | 3 / 5 / 15-min via `TRADE_RESOLUTION` | Simulated | `/ema_rsi_st-paper` |
| **EMA_RSI_ST Backtest** | EMA 20/50 (+9 opt) + RSI + SuperTrend | 3 / 5 / 15-min via `TRADE_RESOLUTION` | Historical | `/ema_rsi_st-backtest` |
| **BB_RSI Live** | BB mean reversion + RSI (V8) | 3 / 5-min | Fyers | `/bb_rsi-live` |
| **BB_RSI Paper** | BB mean reversion + RSI (V8) | 3 / 5-min | Simulated | `/bb_rsi-paper` |
| **BB_RSI Backtest** | BB mean reversion + RSI (V8) | 3 / 5-min | Historical | `/bb_rsi-backtest` |
| **PA Live (legacy)** | Price Action Patterns | 5-min | Fyers | `/pa-live` |
| **PA Live (Harness)** | Price Action Patterns | 5-min | Fyers (PAPER-wrapped) | `/pa-live-harness` |
| **PA Paper** | Price Action Patterns | 5-min | Simulated | `/pa-paper` |
| **PA Backtest** | Price Action Patterns | 5-min | Historical | `/pa-backtest` |
| **PA Pattern Backtest** | Per-pattern attribution | 5-min | Historical | `/pa-pattern-backtest` |
| **ORB Live** | Opening Range Breakout (single-leg CE/PE) | 1-min ticks on a 15-min OR | Fyers | `/orb-live` |
| **ORB Paper** | Opening Range Breakout | 1-min ticks on a 15-min OR | Simulated | `/orb-paper` |
| **ORB Backtest** | Opening Range Breakout | 1-min historical | Historical | `/orb-backtest` |
| **EMA9+VWAP Live** | EMA 9 crosses VWAP ±σ band (Zerodha via harness) | 5-min | Zerodha | `/ema9vwap-live` |
| **EMA9+VWAP Paper** | EMA 9 crosses VWAP ±σ band | 5-min | Simulated | `/ema9vwap-paper` |
| **EMA9+VWAP Backtest** | EMA 9 crosses VWAP ±σ band | 5-min historical | Historical | `/ema9vwap-backtest` |
| **Trend Pullback Paper** | 15m trend bias + 5m pullback/resumption (single-leg slightly-ITM CE/PE) | 5-min | Simulated | `/trend-pb-paper` |
| **Trend Pullback Backtest** | Same + walk-forward OOS folds + dumb-baseline comparison | 5-min historical | Historical | `/trend-pb-backtest` |
| **Trend Pullback Live (Harness)** | Runs Live by wrapping Paper (Fyers orders, triple-gated dry-run) | 5-min | Fyers (PAPER-wrapped) | `/trend-pb-live` |
| **GAPS Paper** | Extreme daily RSI + next-day gap the other way (single-leg slightly-ITM CE/PE) | Daily signal, 5-min exits | Simulated | `/gaps-paper` |
| **GAPS Backtest** | Same engine over a date range (daily signal + intraday exit sim) | Daily + 5-min historical | Historical | `/gaps-backtest` |
| **GAPS Live (Harness)** | Runs Live by wrapping Paper (Fyers orders, triple-gated dry-run) | Daily signal, 5-min exits | Fyers (PAPER-wrapped) | `/gaps-live` |
| **Trend Day Scalp Paper** | 10:15 day gate locks the side, then a VWAP/EMA20 pullback-reclaim (single-leg slightly-ITM CE/PE) | 5-min | Simulated | `/trend-day-scalp-paper` |
| **Trend Day Scalp Backtest** | Same engine over a date range (conservative intra-bar ordering) | 5-min historical | Historical | `/trend-day-scalp-backtest` |
| **Trend Day Scalp Live (Harness)** | Runs Live by wrapping Paper (Fyers orders, triple-gated dry-run) | 5-min | Fyers (PAPER-wrapped) | `/trend-day-scalp-live` |
| **3M Gap Fix Scalp Paper** | Fades a 3-min NIFTY **FUTURES** gap back to its fill level unless the next candle breaks the day high/low on volume | 3-min (futures) | Simulated | `/gap-fix-3m-paper` |
| **3M Gap Fix Scalp Backtest** | Same engine over a date range, front-month contract rolled like the live path | 3-min historical (futures) | Historical | `/gap-fix-3m-backtest` |
| **3M Gap Fix Scalp Live (Harness)** | Runs Live by wrapping Paper (Fyers orders, triple-gated dry-run) | 3-min (futures) | Fyers (PAPER-wrapped) | `/gap-fix-3m-live` |
| **HA Scalp Paper** | A no-wick **Heikin Ashi** candle in the direction of the 50 MA, stopped at that candle's own raw high/low | 15-min (HA) | Simulated | `/ha-scalp-paper` |
| **HA Scalp Backtest** | Same engine over a date range (conservative intra-bar ordering) | 15-min historical | Historical | `/ha-scalp-backtest` |
| **HA Scalp Live (Harness)** | Runs Live by wrapping Paper (Zerodha orders, triple-gated dry-run) | 15-min (HA) | Zerodha (PAPER-wrapped) | `/ha-scalp-live` |
| **OI Wall Fade Paper** | Fades the highest-OI CE/PE strike while that strike's own OI is still **rising** (single-leg slightly-ITM CE/PE) | 5-min + live OI ladder | Simulated | `/oi-wall-fade-paper` |
| **OI Wall Fade Live (Harness)** | Runs Live by wrapping Paper (Fyers orders, triple-gated dry-run) | 5-min + live OI ladder | Fyers (PAPER-wrapped) | `/oi-wall-fade-live` |
| **OI Monitor** | Read-only per-strike OI ladder, walls, band PCR — no position, no order | live OI ladder | — | `/oi-monitor` |
| **Swing Scanner** | Screens a stock universe with one active strategy on a page-local timeframe; manual **CNC/AMO** entry per row | 5m / 15m / 30m / 1h / 4h / 1w (stocks) | Zerodha (manual, real) | `/swing-scanner` |
| **RSI Pivot ST Paper** | RSI(14) extreme + a candle crossing and closing beyond yesterday's Standard Pivot R1/S1 (single-leg OTM CE/PE) | 5-min | Simulated | `/rsi-pivot-st-paper` |
| **RSI Pivot ST Backtest** | Same engine over a date range (conservative intra-bar ordering, δ+θ premium sim) | 5-min historical | Historical | `/rsi-pivot-st-backtest` |
| **RSI Pivot ST Live (Harness)** | Runs Live by wrapping Paper (Zerodha orders, triple-gated dry-run) | 5-min | Zerodha (PAPER-wrapped) | `/rsi-pivot-st-live` |
| **SIMPLE_9:30 Paper** | At 09:25 picks the ITM strike nearest ₹180 on each side; buys whichever clears ₹180 by 09:35, 20pt stop that trails only after the premium touches the box top, 09:45 sideways exit | 1-sec option premium poll | Simulated | `/simple930-paper` |
| **SIMPLE_9:30 Backtest** | Same engine over a date range on **real** 1-min option premium candles (no delta/theta model) | 1-min historical (option premium) | Historical | `/simple930-backtest` |
| **SIMPLE_9:30 Live (Harness)** | Runs Live by wrapping Paper (Zerodha orders, triple-gated dry-run) | 1-sec option premium poll | Zerodha (PAPER-wrapped) | `/simple930-live` |
| **Replay** | Re-runs a recorded paper session through the paper `onTick()` | Recorded ticks | Recorded | `/replay` |
| **All Backtest** | Unified backtest dashboard (per-strategy stats) | Per-strategy | Historical | `/all-backtest` |
| **Manual Tracker** | — (trails SL only) | 15-min | Zerodha | `/tracker` |
| **Simulation** | Any (after-hours) | Configurable | Simulated ticks | `/*/simulate` |

> **PA Live (Harness)** runs Live by wrapping the Paper engine and forwarding decisions to a broker harness, so Live = Paper by construction. The legacy `/pa-live` is preserved during the data-collection window for parity comparison.

### Parallel Compatibility

Within each strategy, Live ⊥ Paper (mutual exclusion). Across strategies, every combination is allowed — EMA_RSI_ST, BB_RSI, PA, ORB can run together (paper or live) on the same Fyers socket via [sharedSocketState](src/utils/sharedSocketState.js). Backtests run in a background queue (one at a time) and never block live/paper modes.

Every backtest's progress page carries a **Cancel Backtest** button (`POST /backtest/cancel?jobId=…`, API_SECRET-protected — the page prompts once per browser session). Cancelling frees the queue slot immediately so a queued tab starts, and the cancelled run's results are discarded. It takes effect at the run's next progress tick, so a strategy whose candle loop reports no progress (ORB) stops only after the fetch phase.

The dashboard has **Start-All Paper** and **Start-All Live** buttons that start every enabled mode in sequence with a single click; the two are **mutually locked** (one disables the other and pulses while active) so you never accidentally double-run paper + live across modes.

Every Start-All run ends in a **confirmation modal that lists each strategy by name with an OK / FAILED verdict**. The verdict is not the HTTP status of `/start` — after the roster has been attempted the page polls each mode's own `/status/data` and reports its `running` flag, retrying up to 4 times (800 ms apart) for the ones not yet up, so a route that returned 200 but whose engine never came up (mutual-exclusion lock, expired broker token, refused socket) is shown as FAILED with the reason. The page reloads when you press OK, unless nothing started at all — then it stays put so the reasons remain readable.

### Dashboard Layout

- **Per-module cards** (EMA_RSI_ST / BB_RSI / PA) — each card has its own Paper/Live toggle, trades, win-rate, total-P&L, and a cumulative P&L chart. Charts colour green/red by P&L sign.
- **Cumulative P&L card** with a Paper/Live toggle that swaps the data source feeding the per-module charts.
- **Top-bar PAPER/LIVE toggle + Range selector** — one pair of controls drives every chart on the page. Range offers *This month* (the Dashboard's default), *Last month*, *Current week expiry*, *All* and *Custom* (From/To) — the same five as Edge Analytics, which defaults to *All*, from one shared definition in [sharedNav.js](src/utils/sharedNav.js). It filters the cumulative chart and all per-module cards (counts, W/L and net included) client-side — no refetch. *Current week expiry* runs from the day after the previous NIFTY weekly expiry through the current one, reading `/api/expiry-dates` so a holiday-preponed expiry is honoured.
- **Side-by-side broker rows** (Fyers + Zerodha on one row).
- **Hover-only date labels** on charts (x-axis decluttered).
- **Sync to Local button** — one click streams `~/trading-data/` as a `tar.gz` to the browser (server → client only). Lets you mirror the EC2 host's persistent data without SSH.

## Strategies

### Strategy 1: EMA_RSI_ST — EMA 20/50 (+9 opt) + RSI + SuperTrend (entry redefined 2026-05-31; PSAR stripped 2026-06-12; 3 / 5 / 15-min via env)
- **Entry (all 4 true; signal candle, entered on the confirmation cross by default)**:
  - **CE**: EMA alignment bullish — 2-EMA (default) EMA20 **above** EMA50, or triple-stack (`EMA_RSI_ST_EMA_TRIPLE_STACK_ENABLED`) EMA9 > EMA20 > EMA50 (`EMA_RSI_ST_EMA_FASTEST`/`EMA_RSI_ST_EMA_FAST`/`EMA_RSI_ST_EMA_SLOW`) · RSI(14) `> RSI_CE_MIN` and `< RSI_CE_MAX` (overbought guard) · **SuperTrend bullish** · **close beyond base EMA** (`EMA_RSI_ST_CLOSE_BEYOND_EMA_ENABLED`, default on): signal candle close **above** the base EMA — base = EMA-fastest (9) when triple-stack is on, else EMA-fast (20).
  - **PE**: mirror — EMA20 **below** EMA50 (or EMA9 < EMA20 < EMA50) · RSI `< RSI_PE_MAX` and `> RSI_PE_MIN` (oversold guard) · **SuperTrend bearish** · signal candle close **below** the base EMA.
- **Confirmation candle** (`EMA_RSI_ST_CONFIRM_CANDLE_ENABLED`, default on): the bar that meets the 3 rules above is the *signal candle*; entry does **not** fire on it. The **immediately-next** candle must cross the signal candle's close (CE above / PE below) — entry then fires intra-bar on the cross. Off = legacy intra-candle entry on the signal bar itself.
- **Initial SL** (unchanged): previous completed candle's **low (CE) / high (PE)** — used as-is (no hybrid cap). `EMA21(OHLC4)` is computed for the SL trail + trade-record snapshot, not an entry input.
- **Trailing**: each candle close, tighten SL to **EMA21** — tighten-only; an EMA21 touch-back is an explicit exit. `EMA_RSI_ST_EMA_EXIT_MODE=close` switches that to **cross & close** (a close beyond EMA21 exits, wicks are held) and takes EMA21 out of the tick-by-tick stop.
- **Exits**: EMA21 trail / EMA touch-back (or cross & close, `EMA_RSI_ST_EMA_EXIT_MODE`), optional N-bar candle trail (`EMA_RSI_ST_CANDLE_TRAIL_ENABLED`, tighter-of) · **negative-candle stop** (`EMA_RSI_ST_NEG_CANDLE_LIMIT`, default 2 — square off a trade still in the red after N candles) · per-trade points stop (`EMA_RSI_ST_STOP_LOSS_PTS`, off by default) · option-premium stop (`OPT_STOP_PCT`) · opposite signal · exit-before-close (`EMA_RSI_ST_EOD_EXIT_TIME`) · EOD auto-stop (`TRADE_STOP_TIME`). Choppy-day guard: halt entries after `EMA_RSI_ST_MAX_CONSEC_LOSSES` consecutive losers (off by default).
- **Same-side cooldown**: after an SL / option-stop hit, block that side for `EMA_RSI_ST_SL_PAUSE_CANDLES` candles.
- **Opposite-side (flip) cooldown**: after any non-flip exit, block the OPPOSITE side for `EMA_RSI_ST_OPPOSITE_SIDE_COOLDOWN_CANDLES` candles (toggle: `EMA_RSI_ST_OPPOSITE_SIDE_COOLDOWN_ENABLED`). Prevents whipsaw flips on chop. Opposite-signal / EOD / manual exits do not trigger it.
- **Guards kept**: VIX gate, `MAX_DAILY_LOSS`, `MAX_DAILY_TRADES`, trading window, OI buildup gate (live), bid-ask spread guard (live), expiry-day-only, EMA_RSI_ST expiry override/type.
- **Removed**: **Parabolic SAR** — fully stripped 2026-06-12 (SuperTrend is the only trend source; EMA21 the only SL). The `EMA_RSI_ST_USE_SUPERTREND` toggle and the `EMA_RSI_ST_SL_MODE=psar` option are gone. Earlier removals: EMA21-price-touch entry gate + `EMA_RSI_ST_ENTRY_REQUIRE_CROSS` / `_CROSS_TOLERANCE`; EMA30 trend gate, ADX, candle-body, SAR-distance, Logic-3 overrides, STRONG/MARGINAL strength tiers, tiered (T1/T2/T3) trail, hybrid initial-SL cap, 50% candle rule.
- **Chart**: EMA20 (gold) + EMA50 (blue) lines, SuperTrend line (green bullish / red bearish), RSI subplot. EMA values + trend source are recorded per trade in the JSON + daily JSONL (`ema9AtEntry`/`ema20AtEntry`/`ema50AtEntry` + `*AtExit`; `ema9*` populated only when the triple-stack is ON).
- **Resolution-agnostic**: same rules on 3 / 5 / 15-min — set `TRADE_RESOLUTION` in `.env` (or via Settings).

### Strategy 2: BB_RSI — Bollinger Band mean reversion + RSI V8 (3 / 5-min)
See [BB_RSI.md](BB_RSI.md) for the authoritative spec. Summary:
- **Direction** (`BB_RSI_DIRECTION`, default `fade`) — `fade` is the V8 mean-reversion engine described below; `breakout` trades the **same signal bars** on the **opposite side** (close above the upper band buys CE), keeping every filter, stop and trail identical so the two can be A/B'd over one backtest range. `breakout` skips the middle-band target (the mean is behind the entry) and flips what "STRONG" means. Leave the divergence filter and the ADX ceiling **off** in `breakout` mode — both are mean-reversion gates. An unrecognised value falls back to `fade`.
- **Entry (at candle close)** — a **mean-reversion fade**, the exact inverse of the V7 breakout it replaced. **CE**: close ≤ BB **lower** band **and** RSI ≤ `BB_RSI_RSI_CE_THRESHOLD(25)` (oversold). **PE**: close ≥ BB **upper** band **and** RSI ≥ `BB_RSI_RSI_PE_THRESHOLD(75)` (overbought). No SuperTrend — a trend filter agrees with the breakout and so vetoes every fade. **Signal-candle filter**: skip when the signal candle's close-to-extreme distance exceeds `BB_RSI_MAX_ENTRY_SL_PTS(50)` pts (avoids uncapped-risk entries).
- **Chop guards** — the sideways tape is what kills a fade, so three gates refuse it. **Band width** (`BB_RSI_BAND_WIDTH_ENABLED`, on): require upper−lower ≥ `BB_RSI_MIN_BAND_WIDTH_PTS(50)`; a band collapsed to noise width has no stretch to fade. **RSI range** (`BB_RSI_RSI_RANGE_ENABLED`, on): over `BB_RSI_RSI_RANGE_LOOKBACK(20)` candles **ending at the bar before the signal**, require max−min RSI ≥ `BB_RSI_RSI_RANGE_MIN(30)` — the signal bar is excluded on purpose, or its own spike would satisfy the test. **ADX ceiling** (`BB_RSI_ADX_ENABLED`, off): block when ADX(14) ≥ `BB_RSI_ADX_MAX(30)` — note this is **inverted** vs V7's ADX floor, because a fade is run over by a strong trend.
- **Divergence** (`BB_RSI_DIVERGENCE_ENABLED`, default **off**): require price to print a new extreme that RSI does not confirm — CE = lower low on a **higher** RSI low, PE = higher high on a **lower** RSI high. Pivots need `BB_RSI_DIV_PIVOT_BARS(2)` bars either side and are searched within `BB_RSI_DIV_LOOKBACK(20)`. No pivot in range = blocked (fails closed).
- **Confirmation candle** (`BB_RSI_CONFIRM_CANDLE_ENABLED`, default on): the bar meeting the entry rules is the *signal candle*; entry does **not** fire on its close. The **immediately-next** candle must cross the signal candle's close (CE above / PE below — the direction of the expected reversal).
- **Confirm on close** (`BB_RSI_CONFIRM_ON_CLOSE`, default on; needs confirmation candle on): that next candle must **CLOSE** past the signal close, and entry fires at the close. Off = enter intra-bar on the first cross. On is the safer default for a fade: a poke up from an oversold extreme that closes back down is a falling knife, not a reversal. *(Replaces `BB_RSI_CONFIRM_OUTSIDE_BAND`, which required the confirmation candle to close **outside** the band — a breakout-only idea that would veto every valid mean-reversion confirmation.)*
- **Guards**: optional `BB_RSI_RSI_TURNING` (require RSI to have already turned back), independent VIX filter.
- **Indicators**: Bollinger Bands `30 / 2`, RSI(14), ADX(14). No SuperTrend.
- **Initial SL line** = the signal candle's own extreme (CE → its low, PE → its high). Used for risk sizing + display; it is **not** an intra-tick stop and does not trail.
- **Exit**: **Middle-band target** (`BB_RSI_TARGET_MIDDLE_BAND`, default on) — per-tick, exit when price reaches the BB middle band; the mean is what the trade is reverting *to*, so it is the objective. → **Two-opposite-candle stop/trail** on candle close, the primary risk rule: an "opposite" candle is one whose **body** closed against the position (CE hurt by a red body, PE by green; a doji breaks the streak). Before the trade has run `BB_RSI_TRAIL_ARM_PTS(10)` in favour this is the **stop** (`BB_RSI_OPP_CANDLE_SL_ENABLED` / `_COUNT(2)`); after, the **trail** takes over with its own count (`BB_RSI_OPP_CANDLE_TRAIL_ENABLED` / `_COUNT(2)`). The two toggle independently — turn the trail off and the stop stays live all trade; turn the stop off and nothing fires until the trail arms. The streak counts only candles closing **after entry**, so a 2-candle stop cannot fire on the first close. The stop pauses its side, the trail does not. → **Hard stop** `BB_RSI_STOP_LOSS_PTS(30)`, a real per-tick backstop because the candle rule can only fire on a close → optional **profit lock** (`BB_RSI_PROFIT_LOCK_TRIGGER_PTS`, default **0** = off; it would cut the trade short of the mean) → bid-ask spread guard → EOD. No BB re-entry exit (back inside the band is now the goal), no SuperTrend flip, no break-even snap, no % spot-trail, no time-stop.
- **Per-side SL pause** (`BB_RSI_PER_SIDE_PAUSE`): an SL on CE only pauses CE entries; PE remains free, plus `BB_RSI_CONSEC_SL_EXTRA_PAUSE` extra candles per consecutive SL.
- **Per-trade context logging** (additive): each trade record captures BB / RSI / trend context at entry and **MFE / MAE** (max-favorable + max-adverse excursion in pts and ₹) over the life of the trade, **`secsToMFE` / `secsToMAE`** (seconds from entry to that peak / trough — distinguishes early-peak-then-giveback from slow-grind, for trail tuning), plus **`vixAtExit`** — feeds the active paper-trade data-collection schema. This enrichment is now uniform across all 4 strategies (paper + live): each logs the signal diagnostics it computes at entry (EMA_RSI_ST: EMA20/50/21 + RSI + SuperTrend; BB_RSI: BB bands / RSI / ADX + band width, RSI range and divergence detail; PA: pattern/trend/SR; ORB: OR width, VWAP side, body-vs-ATR, gate funnel) so post-window analysis can correlate behaviour with market conditions. Timing fields use each engine's replay-safe tick clock so replayed sessions reproduce identical values

### Strategy 3: Price Action — Chart-Pattern Breakouts (5-min)
- **Patterns (the only four entry logics, all default ON)**:
  - **Double Bottom (W) → CE** — twin equal swing lows + close above the neckline (peak between them)
  - **Double Top (M) → PE** — twin equal swing highs + close below the neckline (valley between them)
  - **Ascending Triangle → CE** — flat resistance (equal swing highs) + rising swing lows, close above resistance
  - **Descending Triangle → PE** — flat support (equal swing lows) + falling swing highs, close below support
  - "Equal" levels are within `PA_CHART_PATTERN_TOL=12` pts; the breakout candle body must be ≥ `PA_MIN_BODY=5` pts. Double Top/Bottom also require the two swings ≥5 candles apart. The old Engulfing / Pin Bar / Inside Bar / BOS patterns were removed.
- **Swings**: last `PA_SR_LOOKBACK=30` candles drive both detection and the structure trail.
- **No RSI / ADX confluence** — pure chart patterns; the only entry filter beyond the pattern is the `PA_MIN_BODY` breakout-candle-body check.
- **Retest gate (`PA_RETEST_ENABLED=true`, default ON)**: the breakout candle itself does **not** enter. The breakout is parked and only fires when price pulls back to the broken level (within `PA_RETEST_TOL_PTS=10` pts) and closes back on the breakout side, within `PA_RETEST_MAX_WAIT=4` candles — otherwise it's dropped. This filters breakout-then-instant-reversal fakes (raw-breakout entries once replayed at ~23% WR / −₹11K).
- **SL (pattern structure)**: placed `PA_SL_BUFFER_PTS=3` beyond the pattern extreme — below the twin bottoms / rising-low support (CE), above the twin tops / falling-high resistance (PE) — then clamped to `[PA_MIN_SL_PTS=8, PA_MAX_SL_PTS=25]`.
- **Exit — breakeven then swing trail**: once peak PnL ≥ `PA_BREAKEVEN_TRIGGER=300` (₹), the SL lifts to entry ± `PA_BREAKEVEN_BUFFER=1` pts (a winner can't round-trip to a loss); from there the structure trail tightens the SL to each new swing low (CE) / swing high (PE) on candle close. VIX + OI + bid-ask spread guards apply to entries; EOD square-off 10 min before `TRADE_STOP_TIME`. No profit target, no time-stop. The old candle-trail / tiered profit-lock / time-stop were removed.

### Strategy 4: ORB — Opening Range Breakout (15-min OR, single-leg slightly-ITM CE/PE)
**Rebuilt 2026-07-26.** The V1/V2/V3 engine switches, the RSI/ADX/EMA20-50 stack, the prior-day "fresh ground" filter, and the wick / volume / close-position / fixed-point gates are **deleted, not toggled off** — every one of them was measured on 39 real NIFTY sessions (Mar–Apr 2026) and either had negative edge or never fired. There is now **one engine** with a **9-key signal surface**. See the header of [src/strategies/orb_breakout.js](src/strategies/orb_breakout.js) for the full ablation table.

- **Entry pipeline** — the 09:15–09:30 opening range is **frozen** at 09:30 and never recomputed. A trade requires all of the following, in order:
  1. **Day sanity — OR size**: skip the day when OR width > `ORB_OR_ATR_MAX=2.5 × ATR(15m)` (the open already ran). There is deliberately **no minimum**: the two best trades in the study came from the two *narrowest* opening ranges, so a floor points the wrong way. Fails open until ATR15 is seeded.
  2. **Day sanity — gap**: skip when `|today open − prior close| > ORB_GAP_OR_MULT=3 × OR width` (news, not structure). Fails open when the prior close isn't in the window.
  3. **Committed breakout**: the **first** 5-min *close* to clear the OR edge by `max(0.15×OR, 0.3×ATR5, 1pt)` **and pass step 4** is the one breakout of the day — no second attempt after that. The buffer multipliers are now constants, not env keys.
  4. **Decisive breakout candle**: correct colour, body ≥ `ORB_BODY_ATR_MULT=0.6 × ATR(5m)`, and closing on the right side of session VWAP. This is **the load-bearing filter** — removing it took the worst trade from 0 to −80pt and profit factor from ∞ to 3.3.
     - **2026-08-11 — a weak poke no longer kills the day** (`ORB_BREAKOUT_RESCAN=true`). The scan used to stop at the first close beyond the edge and *then* judge it, so one indecisive bar ended the session: on 2026-08-11 a 7.8pt body at 09:50 (threshold 19.1pt) locked ORB out of a day that fell ~135pt from the ORH. The scan now skips a candidate that fails colour / body / VWAP and keeps hunting for the first bar that clears the edge *and* is decisive — including one on the other side. Selection stays deterministic and repaint-free (each candidate is judged on the frozen ATR5 and the VWAP up to its own close). Set the key `false` to restore first-close-is-final.
  5. **Confirmation — never buy the breakout candle.** The *next* candle must extend the move (higher-high **and** higher-close beyond the edge, still the right side of VWAP).
  6. **Retest / resume fallback** (`ORB_RETEST_MAX_WAIT=6`, `0` disables): if the confirmation candle hesitates, stay armed for up to N candles and take a trend-resume or a retest-and-hold of the edge. A close back through the box cancels the day. A trend that never retests **still enters** — the retest can never veto it.
  7. **Option filter**: slightly-ITM strike (`ORB_ITM_STEPS=1`, CE lower / PE higher; `0` = ATM), LTP inside `[ORB_PREMIUM_MIN, ORB_PREMIUM_MAX]`, bid-ask spread ≤ `ORB_MAX_SPREAD_PTS`. Live/paper only — the backtest has no option chain.
  8. **One trade/day** (`ORB_MAX_DAILY_TRADES=1`), window `ORB_ENTRY_START=09:30` → `ORB_ENTRY_END=11:30`. A stop-out can re-arm the hunt for a fresh breakout — see `ORB_REENTRY_AFTER_SL`, which ships off.
  - Entry is always a **candle close**, never intrabar. ATR(5m)/ATR(15m) are anchored at the 09:30 OR freeze so the committed breakout candle can never be re-judged by later data; they are seeded from a multi-day preload while the OR and VWAP stay day-scoped. (Defensively, the yardstick degrades to **prior days only** rather than to the whole array if the freeze point is ever missing — a branch that is unreachable today, since a valid OR guarantees the freeze index exists.)
  - **⚠️ ATR excluded the overnight gap as of 2026-08-04 (bug fix).** Wilder true range uses the previous bar's close, so the first bar of a session scored `TR` = the close-to-open gap — a move nobody could trade — and that fed the body gate, the buffer, the ATR stop and the OR/ATR15 day filter. Provable case: 2026-07-29 reported `0.6×ATR5 = 34.8pt`, i.e. **ATR(5m) = 58pt, on a day whose entire 15-min opening range was 51.6pt**. All ATR-scaled thresholds now read lower and no longer spike after a gap, so **ORB takes more trades than before** — that is the gate finally running at its intended strictness. Consequence: every ablation number quoted in this section was measured against a distorted ruler and needs re-deriving with `scripts/orbValidate.js`.
- **Exits** (priority order, first to fire wins):
  - **Initial hard SL = the wider of the entry candle's own extreme and `ORB_SL_ATR_MULT=1.5 × ATR(5m)`.** The strategy returns this as `sig.slSpot` and paper/live/backtest all consume it — **one owner**, so the three modes cannot drift. Previously each route recomputed the stop as the entry candle's extreme alone: that averaged **23pt wide and was hit on 4 of 6 trades**, including the session that then ran 213pt our way. Rupee risk is unchanged, because `ORB_MAX_TRADE_LOSS` / `ORB_PREMIUM_STOP_PCT` bind first.
  - **Adaptive breakeven** (`ORB_BREAKEVEN_PTS=20`, `ORB_BREAKEVEN_OR_MULT=0.5`): SL lifts to entry once `max(20, 0.5×OR)` pts in profit. Measured as the single most valuable exit component — removing it cost 106pt and introduced a −77pt worst case.
  - **EMA trend-trail** (`ORB_TRAIL_EMA=20`): exit only when a candle **closes back across** the EMA. Beat EMA9 (183pt) and was chosen over a chandelier trail whose results were non-monotonic in the multiplier (i.e. noise).
  - **Candle trail** (`ORB_CANDLE_TRAIL_ENABLED`, ships **off**): once a candle closes in profit, the hard SL ratchets to the extreme of the last `ORB_CANDLE_TRAIL_CANDLES=2` candles and keeps stepping up candle by candle. Tighten-only. Unlike the EMA trail it ends the trade **intrabar** (it moves the hard stop, which the tick-level check owns), so it gives back less on a sharp reversal and stops out more often on a noisy one. Untested — sweep it.
  - **Strong opposite candle** (`ORB_OPP_CANDLE_EXIT`, `ORB_OPP_CANDLE_BODY_MULT=0.3`), **per-trade caps** (`ORB_MAX_TRADE_LOSS=1500`, `ORB_PREMIUM_STOP_PCT=35`), **EOD** `ORB_FORCED_EXIT=15:15`.
  - **All of the above live in ONE module — [src/strategies/orbExits.js](src/strategies/orbExits.js).** Paper, live, the backtest route and `scripts/orbValidate.js` all call it; routes keep only *execution* (simulate a fill / place a broker order / back-solve a bar fill). They used to be four hand-written copies, which is how the backtest once evaluated the close-based rules before the intrabar ones and silently reported trades the live engine could not have taken. Replay was never affected — it re-runs paper's own `onTick()`. A regression test now fails the build if any route reads an exit key directly again.
- **Risk caps**: `ORB_MAX_DAILY_LOSS=3000` (checked only when flat), **portfolio breaker** (`ORB_RISK_THROTTLE_ENABLED`, persisted at `~/trading-data/orb_risk_state.json`, paper/live tracked separately): sit out after `ORB_MAX_WEEKLY_LOSS=9000` or `ORB_LOSS_STREAK_SKIP=4` consecutive losing days. **VIX gate** (`ORB_VIX_ENABLED`), **OI gate** (`ORB_OI_ENABLED`), **expiry-day-only** (`ORB_EXPIRY_DAY_ONLY`) all still apply.
- **Debugging**: `ORB_DEBUG_TRACE=true` prints the **whole entry funnel** to the logs on every 5-min candle close — time window, OR, day sanity, breakout, body, VWAP, confirmation, retest — each PASS/FAIL/SKIP with its numbers and the final decision. The same trace always rides back on the signal as `sig.gates` (on **every** return path, warm-up included), and the skip log stores it compactly as a `funnel` field — e.g. `time window:P,trade budget:P,OR ready:P,OR vs ATR15:P,gap sanity:P,breakout:F` (~77 bytes) — so a no-trade day can be diagnosed from the log alone rather than only from its first blocking reason. Verbose; turn it off again after diagnosing.
- **Tests**: `npm test` runs the EMA9+VWAP suite **and** [tests/orb.regression.js](tests/orb.regression.js) (37 assertions). The ORB suite guards capital-safety invariants (the rupee clamp can never be exceeded, across every qty × stop-width × side), engine invariants (no repaint, **no look-ahead**, close-only entry, correct stop side), that the six deleted config keys provably no longer change behaviour, that **no engine keeps a private copy of an exit rule**, that the shared exit engine really fires the opposite-candle exit and arms breakeven off the *close* (not the intrabar extreme), and that paper/live/backtest stay in parity on the stop, on crash-recovery persistence and on the duplicate-entry guard. `npm run test:orb` runs it alone.
- **The two stops are now reconciled.** `sig.slSpot` (the ATR stop) is 50–83 spot pts on typical volatility, but `ORB_MAX_TRADE_LOSS=1500` on a 65-lot ~0.6-delta option trips after only **~38 spot pts**. [orbStopRisk.js](src/utils/orbStopRisk.js) clamps the placed stop to whatever the rupee budget allows, so **what the dashboard shows is what executes** — previously the advertised SL was ~2× wider than the level that really ended the trade. It logs whenever it clamps. Raise `ORB_MAX_TRADE_LOSS` if you want the full ATR stop; that is a capital decision, so the default is the conservative direction. **This paragraph described the era when `ORB_MAX_TRADE_LOSS` shipped at 1500 — it now ships at `0` (off), so the clamp is inactive and `ORB_SL_ATR_MULT` is live again, not inert.** With both at `0` the stop is the breakout candle's own extreme and nothing else, which is how 2026-08-03 got a 24pt stop that a wick took out at 10:35 on a day that then traded higher into 12:35. `ORB_SL_ATR_MULT=1.5` is the lever for that; it also makes **every** losing trade lose more, and 9 of the 13 losers on the Jul–Aug 2026 export died on the hard stop — so sweep it, don't assume it.
- **⛔ 2026-08-11 — 329 trades over 2.5 years say ORB does not work. Do not trade it.** The full backtest `2024-01-01 → 2026-08-11` reports **329 trades, 20.7% win rate, net −₹1,78,963, profit factor 0.39, max drawdown −₹1,79,110, Sharpe −5.44**, and every year is negative on its own: 2024 −₹95,275 (n=148, PF 0.30), 2025 −₹51,420 (n=122, PF 0.52), 2026 Jan–Jul −₹32,268 (n=59, PF 0.38). Statistical power needs ~147 trades (≈637 sessions ≈ 2.5 years) — this run has 329 over exactly that span, so it is a verdict, not a small-sample wobble: **buying a slightly-ITM option on a 15-minute opening-range break has no edge on NIFTY.** 79% of trades lose ~₹1,130 each, and a 0-point scratch already costs ~₹420 in spread + theta.
  - **The one filter that looked real failed the third year.** Splitting by opening-range width fit the 2025 + 2026 samples beautifully — **OR ≤ 70pt** gave +₹10.6k / −₹3.4k while **OR > 70pt** gave −₹62k / −₹28.9k at ~14% win — and then **reversed on 2024**, where the cap is *worse* than no cap (OR ≤ 70pt −₹53.6k at PF 0.24 vs OR > 70pt −₹41.7k at PF 0.35). Two years agreeing and the third disagreeing is a fitted rule. Same story for `OR ≤ 60` and "drop plain entries": excellent on 2025, collapsed on 2026. `ORB_OR_MAX_PTS` exists for this hypothesis and **ships off**.
  - **Before proposing any new ORB tweak, run `node scripts/orbSweep.js --from … --to …`.** It forces a train/test date split and refuses to call a winner with fewer than 30 test trades, precisely because every filter tried so far improves in-sample by dropping scratch trades while the 2–3 outlier winners survive at any threshold. If a change cannot beat zero out-of-sample, it is not an improvement to this strategy — it is a different strategy, and the entry is what needs replacing.

- **Known selection bias in the ablation**: tightening `ORB_BODY_ATR_MULT` or `ORB_OR_ATR_MAX` *monotonically* improves every metric on this sample (profit factor 1.4 → 14.6) purely because it removes scratch-cost trades while the 2–3 known winners survive at every threshold. That is the sample selecting itself, not evidence. Do not tune these on 39 sessions.


### Strategy 5: EMA9 + VWAP — EMA 9 crosses the VWAP ±σ band (5-min, Zerodha)
- **Signal source** ([src/strategies/ema9_vwap.js](src/strategies/ema9_vwap.js)): EMA 9 (on 5-min close) vs a **session-anchored VWAP with Standard-Deviation bands** — source HLC3, multiplier `EMA9VWAP_BAND_MULT=1` (= ±1σ, the TradingView default). Set the multiplier to `0` to collapse the band to the plain VWAP line.
- **Entry** (evaluated on candle CLOSE): **CE** when EMA 9 crosses **above** the top line (`VWAP + mult·σ`); **PE** when EMA 9 crosses **below** the bottom line (`VWAP − mult·σ`). Window `EMA9VWAP_ENTRY_START=10:30` → `EMA9VWAP_ENTRY_END=14:30`.
- **Exit — PURE signal exit**: hold the FULL position (no stop-loss / target / trail) until EMA 9 crosses back **inside** the band (CE → back below the top line, PE → back above the bottom line). A trailing position runs past 14:30; hard EOD square-off at `EMA9VWAP_EOD_EXIT_TIME=15:15`. Optional catastrophe stops (`EMA9VWAP_OPT_STOP_PCT`, `EMA9VWAP_STOP_LOSS_PTS`) default **off**.
- **Exit — 2-candle reversal engulf** (`EMA9VWAP_REVERSAL_EXIT_ENABLED`, default **on**): on candle close, square off immediately if the just-closed candle reverses hard against the position — a CE bails on a **bearish** candle (`close < open`) that closes **below both** of the previous 2 candles' lows; a PE on a **bullish** candle that closes **above both** of the previous 2 candles' highs. Rolling reference (each closed candle vs its own prior 2). Turn off to hold purely to the signal / EOD exit.
- **VWAP is EQUAL-WEIGHTED (TWAP) of HLC3 — one formula for all four engines.** Fyers *history* does return per-bar index volume, but the live *tick* feed does not, so a volume-aware formula makes Backtest and Paper compute different bands from the same session (measured: up to **80.49 pts** apart, flipping the signal/exit flag on **41 of 640** evaluations). Equal-weight is the only weighting Paper, Live, Backtest and Replay can all compute identically, and it is what every recorded paper trade used. `computeVwapBands()` in [src/strategies/ema9_vwap.js](src/strategies/ema9_vwap.js) is the single authoritative implementation — no engine has its own. **Documented trade-off:** TradingView's VWAP *is* volume-weighted, so absolute band values here differ from a TV overlay; the EMA9 cross, σ-band shape and session anchor are faithful. Matching TV exactly would need per-bar volume on the LIVE path, which the tick feed does not provide.
- **Entry window is evaluated from the CANDLE TIMESTAMP**, never wall-clock: a signal is in-window when its candle **closes** inside `[EMA9VWAP_ENTRY_START, EMA9VWAP_ENTRY_END)`. `strategy.isEntryWindowOpen()` is shared by Paper, Live and Backtest so the three cannot drift (the Backtest previously gated on the candle's *start*, shifting its window one bar in both directions).
- **Guards**: the VIX gate reads `EMA9VWAP_VIX_ENABLED` / `EMA9VWAP_VIX_MAX_ENTRY`; **both are tri-state — leave them blank to inherit the global `VIX_FILTER_ENABLED` (on unless explicitly false) and `VIX_MAX_ENTRY=20`**, which is the historical behaviour. Set them to decouple EMA9+VWAP from EMA_RSI_ST. The OI-buildup gate is live-only and needs **both** the master `OI_FILTER_ENABLED` and the per-mode `EMA9VWAP_OI_ENABLED` (both default off); the bid-ask-spread guard is live-only. Paper, Live (harness) and Backtest all resolve VIX through the same per-mode reader, so the three surfaces agree. Risk caps `EMA9VWAP_MAX_DAILY_TRADES=20` / `EMA9VWAP_MAX_DAILY_LOSS=5000` (fall back to the global `MAX_DAILY_*`). Circuit breakers: after `EMA9VWAP_MAX_CONSEC_LOSSES` consecutive losses → 5-min pause (4 candles) / 15-min daily kill, **and** the session-halting chop guard. Both read that one key, so `0` (the default) really means OFF — it used to fire at a hardcoded 3 regardless. Cooldowns: same-side SL cooldown `EMA9VWAP_SL_PAUSE_CANDLES=3` (inert unless an optional stop fires) + opposite-side flip cooldown `EMA9VWAP_OPPOSITE_SIDE_COOLDOWN_ENABLED=true`/`_CANDLES=3` after a signal-cross or reversal exit.
- **LIVE = PAPER**: `/ema9vwap-live` runs the paper engine and places **Zerodha** orders via the harness, double-gated by `EMA9VWAP_LIVE_ENABLED` + `LIVE_HARNESS_DRY_RUN`. Backtest is a dedicated candle-loop engine ([src/services/ema9vwapBacktestEngine.js](src/services/ema9vwapBacktestEngine.js)) that mirrors the paper decisions exactly — same VWAP, same entry window, the same **candle-close** EOD cut, same exit ordering, the same circuit breakers and cooldowns (daily loss/trades, the `EMA9VWAP_MAX_CONSEC_LOSSES` streak pause, opposite-side flip cooldown, same-side `EMA9VWAP_SL_PAUSE_CANDLES`), and the same optional stops (`EMA9VWAP_STOP_LOSS_PTS` / `_OPT_STOP_PCT` / `_CANDLE_TRAIL_*` / `_NEG_CANDLE_LIMIT` / `_SL_MODE`) plus `TRADE_EXPIRY_DAY_ONLY`. **Irreducible limitations** (no historical option chain exists for this system): backtest ₹ P&L uses a flat ₹200 entry premium, constant δ0.55 and linear theta with no IV/gamma, and the option-premium stop is approximated as an equivalent spot move — so compare backtest results by sign / trade-count / spot-points, never as a forecast of live rupees. The OI and bid-ask-spread gates are live-only because neither is recorded historically. Runs in parallel with the other strategies on the shared Fyers socket.

### Strategy 6: Trend Pullback — 15m trend bias + 5m pullback/resumption (single-leg slightly-ITM CE/PE, Fyers)
> **All three phases ship now — Paper, Backtest, and Live-via-harness.** Live is **triple-gated to dry-run** (see the Live bullet below); by default nothing places a real order. Design doc: reviewed & approved before implementation, then adversarially code-reviewed (institutional-grade single-strategy build — capital preservation over trade frequency, ≤ ~7 real signal knobs).
- **Philosophy**: the first question is *"should we trade at all?"* — most candles return NONE. Trade **with** an established trend, enter on a **healthy pullback that resumes**. No chasing breakouts, no predicting reversals. Price **structure** is primary; EMA/VWAP/ATR are supporting health filters. Signal source: [src/strategies/trend_pb.js](src/strategies/trend_pb.js) (pure, stateless; 15m + 5m both derived from the 5-min spot series the route feeds in).
- **Entry** (CE / long; PE mirrors inverted) — **all** must hold:
  1. **15m trend bias = UP**: confirmed **higher-high + higher-low** swing structure (`TREND_PB_SWING_LOOKBACK=2` pivots) **and** `EMA20(15m) > EMA50(15m)` **and** EMA20 sloping up **and** spot above session VWAP.
  2. **Healthy 5m pullback**: over the last `TREND_PB_PULLBACK_WINDOW=6` bars, ≥ `TREND_PB_MIN_PULLBACK_BARS=2` against-trend candles dipped back into the `EMA20(5m)` zone **without** falling more than `TREND_PB_PULLBACK_MAX_ATR=1.5 × ATR(5m)` beyond it (rejects deep/broken pullbacks).
  3. **Resumption candle** (the just-closed 5m bar): closes **back above `EMA20(5m)` and above the prior candle's high**, with **body ≥ `TREND_PB_BODY_ATR_MULT=0.5 × ATR(5m)`** — the conviction proxy that replaces volume (NIFTY spot has no real volume; same caveat as ORB/EMA9+VWAP VWAP). Enters on close, never a wick.
  - Window `TREND_PB_ENTRY_START=09:45` → `TREND_PB_ENTRY_END=14:30`. Optional `TREND_PB_ATR_FLOOR_PTS` no-trade filter (0 = off) skips compressed-range days.
- **Option filter**: slightly-ITM (`TREND_PB_ITM_STEPS=1`, ~delta 0.6), premium in `[TREND_PB_PREMIUM_MIN=120, TREND_PB_PREMIUM_MAX=400]`, bid-ask spread ≤ `TREND_PB_MAX_SPREAD_PTS=2` (via [tradeGuards](src/utils/tradeGuards.js), falls back to global `MAX_BID_ASK_SPREAD_PTS`).
- **Exit — highest priority, right-tail focused, all measured on SPOT** (premium only for the backstop): initial **structural stop** at the pullback extreme, clamped to `[TREND_PB_STOP_CLAMP_MIN=8, TREND_PB_STOP_CLAMP_MAX=30]` pts → **breakeven** at `TREND_PB_BREAKEVEN_R=1.0 ×` initial risk → **ATR-chandelier trail** at `best-spot − TREND_PB_TRAIL_ATR_MULT=2.5 × ATR(5m)` (ratchets one way — the winner-runner) → **EMA20(5m)-close trend-failure** (`TREND_PB_TRAIL_EMA=20`) → **time-stop** (`TREND_PB_TIME_STOP_CANDLES=6` flat candles) → **EOD** `TREND_PB_FORCED_EXIT=15:15` → **premium disaster backstop** `TREND_PB_PREMIUM_STOP_PCT=35`. **No fixed target, no partial booking** (partials cap the right tail that pays for the small losers). Optional `TREND_PB_MAX_TRADE_LOSS` (₹, default off).
- **Risk**: `TREND_PB_MAX_DAILY_TRADES=3` (selective), `TREND_PB_MAX_DAILY_LOSS=5000`, `TREND_PB_LOSS_STREAK_SKIP=3` consecutive-loss session cool-off. Fixed lot size (confidence-scaled sizing deliberately avoided until out-of-sample validated). **Guards**: per-mode VIX gate `TREND_PB_VIX_ENABLED` (off; `TREND_PB_VIX_MAX_ENTRY=22`, falls back to global `VIX_MAX_ENTRY`), OI-buildup gate `TREND_PB_OI_ENABLED` (off; needs master `OI_FILTER_ENABLED`).
- Runs on the shared **Fyers** socket in parallel with the other strategies; paper trades persist to `~/trading-data/trend_pb_paper_trades.json` + the per-day JSONL audit log (`mode: "trend_pb"`).
- **LIVE = PAPER** (`/trend-pb-live`, [src/routes/trendPbLiveHarness.js](src/routes/trendPbLiveHarness.js)): runs Live by wrapping the Paper engine with the shared harness — it triggers `/trend-pb-paper/start` under the hood and places real **Fyers** orders as paper's entries/exits fire, so Live = Paper by construction (no separate live decision path). **Triple-gated to dry-run**: real orders require `TREND_PB_LIVE_ENABLED=true` AND `LIVE_HARNESS_DRY_RUN=false` AND `TREND_PB_LIVE_DRY_RUN` not-true, plus an authenticated Fyers session — by default nothing places a real order. Validate that Live decisions match Paper on a recorded `/replay` session before flipping the gates. (Like ORB, it ships without positionPersist crash-recovery of an open live position — a restart mid-trade won't auto-reconcile the broker position.)
- **Backtest** (`/trend-pb-backtest`, [src/routes/trendPbBacktest.js](src/routes/trendPbBacktest.js)): replays 5-min candles through the **same** `getSignal` and re-implements the paper SPOT exits (paper canonical — it does NOT use the shared engine). Option P&L is δ+θ simulated seeded slightly-ITM, **plus a spread/slippage haircut** `TREND_PB_BT_SLIPPAGE_PTS=1.5`pt each way (`getCharges` on top) — so the curve doesn't lie about option-buying costs. Reports the full stat set (win rate, profit factor, expectancy, Sharpe, equity-curve max-drawdown, R:R). Two honesty features baked in: (1) a **dumb baseline** — the same range run with a naive "enter in the 15m-trend direction at the window open, same trail+EOD, NO pullback filter" engine — the strategy must beat it or its filters are noise; (2) **walk-forward** ([src/utils/walkForward.js](src/utils/walkForward.js)) — trades split into rolling ~20-day out-of-sample folds with a stability verdict and thin-fold (< 20 trades) flags, since a "win" inside a tiny sample is noise, not proven edge.

### Strategy 7: GAPS — extreme daily RSI + a next-day gap the other way (single-leg slightly-ITM CE/PE, Fyers)
> **Deliberately minimal.** Two facts about yesterday, one about today's open. No trend filter, no volume, no ADX, no VWAP, no OI, no confirmation candle, no multi-timeframe logic — by design, not by omission. Signal source: [src/strategies/gaps.js](src/strategies/gaps.js) (pure, stateless; shared by Paper, Backtest and Replay).
- **Indicators — both on the NIFTY DAILY series**:
  - `EMA(GAPS_EMA_LENGTH=21)` of daily close.
  - `RSI(GAPS_RSI_LENGTH=14)` whose **input source is configurable and defaults to `ema`** — i.e. RSI is computed over the EMA21 series, not over close. This is TradingView's **"EMA: EMA"** source option: plotting RSI on the EMA line double-smooths it so it actually reaches the 90 / 10 extremes a close-sourced RSI almost never touches. `GAPS_RSI_SOURCE=close` gives a plain RSI; `open`/`high`/`low`/`hl2`/`hlc3`/`ohlc4` are also accepted.
- **Entry — evaluated ONCE, at today's open**:
  - **PE (short)**: **today's** daily RSI **>** `GAPS_RSI_UPPER=90` **and** today's open **below** yesterday's close (gap **DOWN**).
  - **CE (long)**: **today's** daily RSI **<** `GAPS_RSI_LOWER=10` **and** today's open **above** yesterday's close (gap **UP**).
  - The two halves read **different days**: the RSI is **today's**, the gap is measured against **yesterday's close**.
  - **Today's RSI** is the daily RSI including today's bar. At 09:15 that bar has exactly one price — today's open — so it is built from the open. Using the open rather than the live spot is deliberate: it is the price the whole decision already rests on, it is fixed the moment the market opens, and it makes Paper, Live, Backtest and Replay compute the identical number. A live-spot RSI would drift second by second and could never be reproduced in Replay.
  - "Yesterday" always means the last daily candle that closed **strictly before** the session day — today's forming daily bar is dropped by IST day number, so Paper, Live, Backtest and Replay all read the same bar. If the daily indicator series does not end on that bar (a history hole), the engine **refuses** rather than quoting a stale RSI.
  - Window `GAPS_ENTRY_START=09:15` → `GAPS_ENTRY_END=09:30`. The gap decision is only valid at the open, so keep this short; starting a session after the window logs a skip and takes no trade.
- **Stop loss**: the **gap size in points**, measured on SPOT from the price actually filled — a PE is stopped that many points **above** the fill, a CE that many points **below**. Checked per tick.
  - Filling at the open makes this land exactly on yesterday's close, i.e. the gap-fill level (`open ± gap == prev close`). Filling a little later — the entry window runs to `GAPS_ENTRY_END=09:30` — keeps the risk pinned at the gap instead of letting it stretch toward yesterday's close. Example: prev close 24,800, open 24,750 (50pt gap down) → PE with a 50pt stop. Fill at 24,750 and the stop is 24,800; fill at 24,730 and it is 24,780, still exactly 50pt of risk.
- **Trailing stop**: `EMA(GAPS_TRAIL_EMA_LENGTH=21)` on the **intraday** `GAPS_EXIT_TF=5`-minute candles. The trade rides as long as price stays on the winning side of that EMA and exits when a candle **CLOSES back THROUGH it** — a PE exits on a close **above** the EMA, a CE on a close **below**. A close, never a wick. Because the EMA is recomputed every candle the exit level **moves with price**; it is a trailing stop, not a fixed target. `GAPS_TRAIL_ENABLED=false` runs gap-size-stop-and-EOD only.
  - The trail EMA runs over a **continuous multi-day** intraday series (Paper's preload lookback scales with `GAPS_EXIT_TF` to clear ~150 bars; the backtest computes it across the whole range), so it is already warm at 09:15 rather than needing ~105 minutes to form. If it is somehow not warm, the route says so and the gap-size stop is the only exit until it is.
  - `GAPS_TRAIL_EMA_LENGTH` is deliberately **separate** from `GAPS_EMA_LENGTH`. The latter is the *daily* EMA that feeds the RSI ("EMA: EMA" source); tuning the RSI smoothing must not silently move the stop. Both default to 21.
- **No other exit exists** — no fixed target, no breakeven, no time stop, no ATR exit, no opposite-candle exit. Anything still open is squared off at `GAPS_FORCED_EXIT=15:15`.
- **Option**: slightly-ITM (`GAPS_ITM_STEPS=1`, ~delta 0.6). Sizing via `GAPS_LOT_MULTIPLIER` (0 = inherit the global `LOT_MULTIPLIER`; clamped by `MAX_LOT_MULTIPLIER`).
- **Risk**: `GAPS_MAX_DAILY_TRADES=1` (one decision per day by construction), `GAPS_MAX_DAILY_LOSS=5000`, `GAPS_MAX_WEEKLY_LOSS=0` (off; when set, a rolling Mon→today cap read from the per-day GAPS JSONL logs), `GAPS_LOSS_STREAK_SKIP=3` consecutive-loss breaker, plus the shared portfolio-wide cap. **No VIX or OI gate** — none was specified, so none was added.
- **Charts**: the Paper page renders the **daily** chart the strategy actually reads — daily candles + `EMA21` + an RSI pane with the configured `90` / `10` band lines, all served from the same engine that produced the decision, so the chart can never disagree with the trade. Below it, the intraday chart draws the stop as a price line and the **moving** `EMA21` trail as a live series, computed by the same engine call the exit uses — so the green line on the chart is literally the level that would close the trade.
- Runs on the shared **Fyers** socket in parallel with the other strategies; paper trades persist to `~/trading-data/gaps_paper_trades.json` + the per-day JSONL audit log (`mode: "gaps"`).
- **LIVE = PAPER** (`/gaps-live`, [src/routes/gapsLiveHarness.js](src/routes/gapsLiveHarness.js)): runs Live by wrapping the Paper engine with the shared harness — it triggers `/gaps-paper/start` under the hood and places real **Fyers** orders as paper's entry/exit fires, so Live = Paper by construction. **Triple-gated to dry-run**: real orders require `GAPS_LIVE_ENABLED=true` AND `LIVE_HARNESS_DRY_RUN=false` AND `GAPS_LIVE_DRY_RUN` not-true, plus an authenticated Fyers session. An open GAPS position is crash-recovered via `positionPersist` (`.active_gaps_position.json`) and reconciled against the broker book on boot.
- **Backtest** (`/gaps-backtest`, [src/routes/gapsBacktest.js](src/routes/gapsBacktest.js)): fetches the daily series (with ~400 days of warmup runway before `from` so RSI-on-EMA is seeded on day one) plus `GAPS_EXIT_TF` intraday candles, then drives the **same** `getSignal` per session and re-implements the paper exits (paper canonical). Conservative intra-bar ordering: the gap-size stop is tested on the bar's high/low **before** the trail is tested on the close, and a bar that opened beyond the stop fills at the open, never at the better level. Option P&L is δ+θ simulated seeded at `GAPS_BT_SEED_PREMIUM=240` **plus a spread/slippage haircut** `GAPS_BT_SLIPPAGE_PTS=1.5`pt each way. **GAPS is low-frequency** — a 30-day range usually produces very few trades, so the default range is 180 days; widen it before drawing any conclusion.

### Strategy 8: TREND DAY SCALP — a 10:15 day gate, then one bought dip (single-leg slightly-ITM CE/PE, Fyers)

**Never traded.** Zero paper sessions, zero live orders. `TDS_MAX_SL_PTS` and `TDS_EXTENSION_MULT` are set from a **measured** distribution (39 sessions) after their original arithmetic-derived values produced 5 trades in a year — measured-from is not the same as validated, and neither was chosen for its P&L. Every **other** constant below is still an unmeasured prior derived from the cost arithmetic. Collect clean paper days and diff them against `/replay` before touching any live gate.

**Why it exists.** Every other engine here is a naked directional bet that lets winners run, and each is right-tail dependent — ORB's own header records 9 trades where the best is 211% of net (remove it and the strategy is −₹3,786); EMA9+VWAP's +₹16k was one trade. This one inverts that on purpose: a **fixed** target, a **fixed**-size stop, and a day filter whose main job is to produce a **zero** instead of a loss. It gives up the huge winner to get a result that does not depend on catching one.

**The binding constraint is friction, not signal.** Measured with this repo's own `charges.js` on 1 lot: ~₹90 statutory + ~1.5 premium points of slippage per side (~₹225) ≈ **₹315 gone before the trade is right about anything**. At delta ~0.6 that is ~17 spot points of edge just to break even — which is why the target floor is 2.5R and not a scalper's ten points.

- **Day gate** — evaluated ONCE on the 5-min bar closing at `TDS_GATE_TIME=10:15`, then **frozen for the day**. All three must hold:
  1. first-hour (`TDS_SESSION_START=09:15` → gate) range ≥ `TDS_MIN_RANGE_PCT=0.5`% of spot — the day actually moved;
  2. the last `TDS_VWAP_STREAK_BARS=6` closes are ALL on the same side of the running VWAP — one-directional, not chop;
  3. `|spot − VWAP| ≥ TDS_EXTENSION_MULT=0.20 ×` the first-hour range — committed, not drifting on the line. **Measured**, not reasoned: the real distribution over 39 sessions is median 0.18 / p90 0.39, so the original 0.35 passed only 13% of days.
  - Fail any one → **NO TRADE TODAY**. That zero is the design goal, not a missed opportunity.
  - **Why 0.20 — and why 0.6 and 0.35 before it were both wrong.** The original reasoning was that on a perfectly linear ramp the time-weighted VWAP lands at `(L+H)/2`, so spot−VWAP is exactly 0.5 × range. That is arithmetic on a path the market does not walk: real first hours are not straight lines and VWAP tracks price far more closely, so the measured distance is **median 0.18 × range, p90 0.39** over 39 sessions. `0.35` therefore sat near the 85th percentile and passed **13% of days** — that plus the 18pt stop cap is why the first 2025 backtest returned 5 trades. `0.20` is just above the measured median. It is deliberately **not** the best-scoring value on that sample (`0.15` was): 17 trades cannot separate the two, and picking the peak of a noisy sweep is a curve fit.
- **Direction is LOCKED by the gate**: spot above VWAP → **CE only**, below → **PE only**. Never counter-trend, never flips later in the day.
- **Entry** — a pullback into the zone that is immediately reclaimed, on a closed 5-min bar. The zone is the **nearer** of VWAP and `EMA(TDS_EMA_PERIOD=20)` to price (max of the two for CE, min for PE). All four must hold:
  - *touch* — the lowest low of the last `TDS_PULLBACK_WINDOW=3` bars reached the zone. **A wick is enough**: `trend_pb.js` already defines a pullback that way, and on a genuine trend day price usually just grazes the line and bounces — demanding a *close* beyond it means waiting for the trend to actually break before buying its continuation.
  - *reclaim* — this bar CLOSES back beyond the zone.
  - *freshness* — either the previous bar closed on the wrong side of its own zone (a multi-bar dip) or THIS bar's low dipped in (a pin bar). Blocks firing on every bar of a rally already under way.
  - *conviction* — right colour, body ≥ `TDS_BODY_ATR_MULT=0.4 × ATR(TDS_ATR_PERIOD=14)`.
  - Window: gate → `TDS_ENTRY_END=14:00`.
- **Stop** = the pullback extreme, **floor-clamped** to `TDS_MIN_SL_PTS=12`. If the structure needs MORE than `TDS_MAX_SL_PTS=40` the trade is **SKIPPED** — never widened, and never tightened inside the structure.
  - **The cap was 18 and that was a design error.** Measured over 39 sessions: valid setups have a structural stop of **median 35pt** (p25 26, p75 47), so an 18pt cap skipped **48 of 53** setups and kept only the shallowest — adversely selected, and all of them lost. A pullback deep enough to reach VWAP/EMA20 on 5-min NIFTY simply costs 25–35 index points.
  - **Be clear about the cost:** ~35pt of index risk is roughly **₹1,400 of premium on 1 lot** at delta 0.6. This is no longer the "small fixed risk" the strategy was first pitched with.
- **Target** = a FIXED `entry ± TDS_TARGET_R=2.5 ×` the stop distance. Taken when reached, not trailed past.
- **Does the entry predict anything at all?** Two years of backtests put this strategy between PF 0.6 and 1.14 depending on which knob was turned — the signature of no edge rather than of a strategy needing a tweak. `node scripts/tdsEdgeTest.js --from 2024-01-01 --to 2026-08-09` answers it directly: on the same gate-passing days, with the same locked side, stop rule, target, exits and costs, it compares the real entry against hundreds of **randomly timed** entries. If the real entry lands mid-pack, the pullback-and-reclaim rule is noise and the day gate plus the risk model are doing all the work — no stop/target tuning can fix that. Reads whatever `TDS_*` values are live, so it tests the config you are actually running. Needs a valid Fyers token.
- **Exits**, in the order tested on every tick: hard stop → fixed target → **breakeven jump** (at `+TDS_BREAKEVEN_R=1`R the stop moves **ONCE** to `entry ± TDS_BREAKEVEN_BUFFER_PTS=3` and then **never moves again**) → time stop (`TDS_TIME_STOP_MINS=25`, only while un-armed) → premium stop (`TDS_PREMIUM_STOP_PCT=25`%, catches an IV crush the spot stop cannot see) → EOD `TDS_FORCED_EXIT=15:10`.
  - **There is deliberately NO rolling trail and no partial booking.** A rolling trail is exactly what turns this repo's other engines' winners into scratches; the fixed target does that job instead.
- **Day-level breakers**: `TDS_MAX_DAILY_TRADES=2`, `TDS_MAX_DAILY_LOSSES=2` **real stop-outs** ends the day (a breakeven or time-stop exit is a scratch and does **not** count), `TDS_MAX_DAILY_LOSS=3000`, `TDS_DAILY_PROFIT_LOCK=3000` (stop while ahead — handing profit back is what wrecks a steady curve), `TDS_MAX_WEEKLY_LOSS=0` (off), plus the shared portfolio-wide cap.
- **Option**: slightly-ITM (`TDS_ITM_STEPS=1`, ~delta 0.6). Sizing via `TDS_LOT_MULTIPLIER` (0 = inherit the global `LOT_MULTIPLIER`; clamped by `MAX_LOT_MULTIPLIER`).
- **Deliberately NOT here** (do not "helpfully" add them): no VIX gate, no OI filter, no ADX, no volume, no RSI, no SuperTrend, no multi-timeframe bias, no confirmation candle, no averaging, no pyramiding.
- **Determinism**: every value the decision reads comes from CLOSED 5-min candle OHLC — never the live spot — so Paper, Backtest, Live and Replay compute identical numbers. The VWAP is **equal-weighted HLC3** (a TWAP), matching `ema9_vwap.js`: the Fyers live tick feed carries no per-bar index volume while Fyers HISTORY does, so a volume-weighted VWAP would make Paper and Backtest disagree about the same session.
- **LIVE = PAPER** (`/trend-day-scalp-live`, [src/routes/trendDayScalpLiveHarness.js](src/routes/trendDayScalpLiveHarness.js)): wraps the Paper engine with the shared harness, so Live = Paper by construction. **Triple-gated to dry-run**: real orders require `TDS_LIVE_ENABLED=true` AND `LIVE_HARNESS_DRY_RUN=false` AND `TDS_LIVE_DRY_RUN` not-true, plus an authenticated Fyers session. An open position is crash-recovered via `positionPersist` (`.active_trend_day_scalp_position.json`, which persists the full bracket including whether breakeven had already armed) and reconciled against the broker book on boot.
- **Backtest** (`/trend-day-scalp-backtest`, [src/routes/trendDayScalpBacktest.js](src/routes/trendDayScalpBacktest.js)): drives the **same** `evaluateDayGate` + `getSignal` and re-implements only paper's exits (paper canonical). **Conservative intra-bar ordering** — the adverse stop is tested on the bar's high/low **before** the favourable target, so a bar touching both books the LOSS; a bar that opened beyond a level fills at the **open**, never the better level; the breakeven jump arms off the bar's favourable extreme but the moved stop can only be hit on a **later** bar. Option P&L is δ+θ simulated seeded at `TDS_BT_SEED_PREMIUM=240` plus a `TDS_BT_SLIPPAGE_PTS=1.5`pt haircut **each way**. The premium stop fires on that modelled curve, not on a real IV crush. **The gate rejects most sessions by design, so a short range shows very few trades.**

### Tick Replay — deterministic re-run of recorded sessions
- Every trading day records spot, option (incl. entry-time bid/ask), VIX, and futures-OI ticks to `<repo>/data/ticks/YYYY-MM-DD/*.jsonl` when `TICK_RECORDER_ENABLED=true` (default; pure observer, no trade-path impact). OI is recorded only while an OI filter is enabled. Retention: `TICK_RECORDER_RETAIN_DAYS=30`.
  - **Note the location**: unlike the rest of the persistent state, the tick archive lives *inside* the repo directory (`data/ticks`), not in `~/trading-data`. On EC2 that is `/var/www/html/trade/data/ticks`, and it survives deploys only because the deploy rsync runs **without `--delete`** ([.github/workflows/deployCodeToEc2.yml](.github/workflows/deployCodeToEc2.yml) leaves `ARGS` at its default). Adding `--delete` there would erase every recorded day on the next push — recordings that can never be re-made.
- **Recording is day-based, not strategy-based.** A supervisor (`SPOT_FEED_ALWAYS_ON=true`, default) keeps the shared spot feed connected 09:15–15:30 IST **even when no strategy is running**, and re-connects within seconds if stopping the last strategy tears the socket down mid-session. So a day is archived in full whether you ran zero, one, or six strategies — and strategies added later still get a complete day to replay. The supervisor opens no second socket, registers no tick callback, places no order, and never stops a feed a strategy is still using.
- Separately, a **day-wide option-chain recorder** (`OPTION_CHAIN_RECORDER_ENABLED=true`, default) proactively captures the ATM±N chain + VIX + futures-OI + **per-strike OI** every few seconds regardless of which strategies run — so a SNAPSHOT replay is reproducible for **any** strategy, including a strike no live strategy traded that day or a strategy created later. Tunable via `OPTION_CHAIN_RECORD_INTERVAL_SEC` / `OPTION_CHAIN_RECORD_STRIKES`.
- **Market Context Snapshot** (`market.jsonl`): the first live spot tick of each day freezes an immutable, **strategy-independent** snapshot of that day's market facts — weekly + monthly expiry (as `YYYY-MM-DD` dates), strike interval, lot size, instrument/exchange/broker meta, and schema versions — captured once regardless of which (or how many) strategies run. Replay reads this as the **source of truth for historical market data**, so an old day always resolves its own option contract instead of today's expiry. This is what a future strategy *would* use to replay a day recorded before it existed — the data is archived for it, but the entry point that consumed it is currently removed (see the whole-day note below).
- `/replay` re-runs a recorded session through the same paper `onTick()` handlers to produce **bit-identical** results.
- Two modes: **Snapshot mode** uses the session-start settings snapshot from that day's JSONL → identical output every run; **Current-settings mode** uses the live `process.env` so you can A/B settings changes against real ticks after hours. In **both** modes the option **expiry date is pinned from the Market Context Snapshot** — current settings only override strategy config (entry/exit/filters/risk/sizing), never the historical expiry. (Recordings made before this feature have no `market.jsonl` → replay logs a warning and falls back to the legacy per-session expiry pin.)
- Outputs land in `~/trading-data/_replay_trades/` (snapshot) or `_replay_trades_sim/` (current-settings) — kept separate from the canonical paper logs.
- Date-range replays loop per session and render a per-row table with one-click re-runs.
- **Only sessions that actually ran are replayable.** A recorded day with no session marker for a strategy (it wasn't started, or didn't exist yet) cannot be replayed for it, and stays greyed out in the From/To calendars. Whole-day replay was removed on 2026-07-28 after an EMA9+VWAP run found no recorded premiums under its own option symbol and silently priced every trade off the spot move 1:1 — a P&L that looks real but is roughly double what the option would have done. The day-wide option-chain recorder above is meant to prevent exactly that, so this is expected to come back once it's confirmed why that symbol was missing from the recording.

### Market Scenario Simulator
- After-hours testing with 8 scenarios: trending up/down, choppy, volatile, breakout up/down, V-recovery, inverted-V
- Each generates ~75 candles simulating a full 9:15–15:30 session
- Runs the production `onTick()` pipeline — same SL, trailing, exit logic as live
- Historical date replay with 1-min candle tick replay (300-candle warmup for EMA_RSI_ST/PA)
- Zigzag intra-candle tick noise (not smooth O→H→L→C arc) for realistic fills
- Available for all 3 strategy modes

### Live NIFTY Chart Overlay
- Live candlestick chart on all paper + live status pages (toggleable via `CHART_ENABLED`)
- **Entry logic overlays**: Bollinger Bands on bb_rsi charts, swing points on PA charts
- **Entry/exit markers** for every trade on the session chart
- **Click any trade row** to focus chart on that trade only; click-to-reset restores full session view
- **Chart zoom preserved** across auto-refresh (even while focused on a trade)

### Strategy 9: 3M GAP FIX SCALP — fade a 3-minute FUTURES gap back into itself (single-leg slightly-ITM CE/PE, Fyers)

**Never traded, and its trade frequency has never been measured.** Zero paper sessions, zero live orders. Every constant is a prior; `GAP3M_MIN_GAP_PTS` is a friction floor rather than a fitted value. Collect clean paper days and diff them against `/replay` before touching any live gate.

**The chart is NIFTY FUTURES, and that is not a preference.** Measured on this repo's own cached NIFTY 50 **index** candles over 39 sessions: only 12 intraday gaps occurred, the largest was **2.1 points**, median **0.45**. An index is a continuously recomputed average of 50 stocks — it has no order book, so it does not leave voids. NIFTY futures is one traded contract with a real book, and that book is what gaps. The index is still read for exactly two things: the option **strike** (strikes are struck on the index, not on the future) and the second chart on the Paper page. No rule reads it.

**The rules** ([src/strategies/gap_fix_3m.js](src/strategies/gap_fix_3m.js) — the only place they exist):

- **Day high / day low** — running over today's in-session futures bars, and **FROZEN** into the setup the moment a gap is found. A stop must not drift away from an open trade, and a frozen level is the only kind Replay can reproduce.
- **Gap** — between two consecutive closed bars A and B: gap **up** when `B.low > A.high`, gap **down** when `B.high < A.low`. Strict inequality — a touch is not a void. Smaller than `GAP3M_MIN_GAP_PTS=20` is ignored.
- **Why 20 and not 5** — the gap size **is** the target. `charges.js` on 1 lot takes ~₹90 round-trip plus ~1.5 premium points of slippage per side; at delta ~0.6 that is **~7.3 index points** before the trade has made anything, and a target must clear it with room. Below ~17 the strategy is negative-expectancy by arithmetic whatever the win rate says.
- **Confirm** — the next bar (`GAP3M_CONFIRM_BARS=1`) decides, and the decision table is exhaustive:
  - broke the day extreme **AND** volume ≥ `GAP3M_VOL_MULT=1.5 ×` the average of the previous `GAP3M_VOL_AVG_BARS=20` bars → **SKIP**. Real breakout.
  - broke it **AND volume is unknown** → **SKIP**, fail-safe. Without volume the break cannot be shown to be weak, and fading a genuine breakout is the expensive mistake.
  - **returned** (`GAP3M_RETURN_MODE=reverse_close`: closes against the gap AND gives back ground vs the gap bar's close) → **ENTER**. A weak-volume poke that came back still qualifies, and is the strongest form of the setup.
  - otherwise → wait; the setup expires with the bar.
- **Direction** — gap up is faded DOWN (buy PE), gap down faded UP (buy CE).
- **Target** = the gap's fill level (`A.high` for a gap up, `A.low` for a gap down). **Stop** = the frozen day extreme ± `GAP3M_SL_BUFFER_PTS=0`. Both are LEVELS, both frozen, neither ever moves.
- **The geometry to understand before tuning anything.** Target + stop is a FIXED span — the distance from the gap's far edge to the day extreme — and where the confirm candle closes decides how that span is split. Run on one 22pt gap with only the confirm close changed, the engine returns R:R from **3.75** (shallow return, stop close by) down to **0.27** (deep return back inside the void, stop far away). A shallow return is the better trade even though a deep one looks more convincing, which is why `reverse_close` is the default and `into_gap` is the option.
- **Exits**: gap filled → day extreme taken out → EOD `GAP3M_FORCED_EXIT=15:15`. That is all. **No trail, no breakeven jump, no partial booking, no time stop, no premium stop, no re-entry.**
- **Three guards ship OFF on purpose**: `GAP3M_MIN_RR`, `GAP3M_MAX_SL_PTS` and `GAP3M_MAX_EXTREME_DIST_PTS` all default to `0`. Out of the box the engine does exactly what the rules say — including taking a wide-stop trade when the gap forms far from the day extreme. They are levers for once there is data, not guesses baked into a default.
- **Day-level breakers**: `GAP3M_MAX_DAILY_TRADES=3`, `GAP3M_MAX_DAILY_LOSSES=2` stop-outs, `GAP3M_MAX_DAILY_LOSS=3000`, `GAP3M_DAILY_PROFIT_LOCK=0` (off), `GAP3M_MAX_WEEKLY_LOSS=0` (off), plus the shared portfolio-wide cap.
- **Option**: slightly-ITM (`GAP3M_ITM_STEPS=1`, ~delta 0.6), strike chosen off the **index** spot. Sizing via `GAP3M_LOT_MULTIPLIER` (0 = inherit the global `LOT_MULTIPLIER`; clamped by `MAX_LOT_MULTIPLIER`).
- **How the data arrives.** Closed 3-min futures bars come from the Fyers **history** endpoint, refreshed once per bar `GAP3M_HISTORY_LAG_MS=5000` after it closes — the same endpoint the backtest and replay read, which is what makes the four modes agree on a session. The live futures price the two exit levels are checked against comes from a quote poll every `GAP3M_FUT_POLL_MS=2000`, because the shared tick socket carries the **index**, not the future. **Exits therefore resolve at ~2-second granularity, not per tick** — the honest caveat when reading a fill price.
- **LIVE = PAPER** (`/gap-fix-3m-live`, [src/routes/gapFix3mLiveHarness.js](src/routes/gapFix3mLiveHarness.js)): wraps the Paper engine with the shared harness. **Triple-gated to dry-run**: real orders require `GAP3M_LIVE_ENABLED=true` AND `LIVE_HARNESS_DRY_RUN=false` AND `GAP3M_LIVE_DRY_RUN` not-true, plus an authenticated Fyers session. An open position is crash-recovered via `positionPersist` (`.active_gap_fix_3m_position.json`) and reconciled against the broker book on boot.
- **Backtest** (`/gap-fix-3m-backtest`, [src/routes/gapFix3mBacktest.js](src/routes/gapFix3mBacktest.js)): drives the **same** `getSignal` and re-implements only paper's exits (paper canonical). There is no continuous futures series, so the range is split into **front-month contract blocks** using the identical roll rule the live path uses (roll two days before the last **Tuesday** — NIFTY futures expire on the last Tuesday of their month, verified against Fyers' symbol master) and each block is fetched from its own symbol — bars from two contracts are never adjacent inside a session, so a roll can never be mistaken for a gap.
- **How far back it can go is limited by Fyers, not by this code.** A NIFTY futures contract is **delisted once it expires**, and Fyers then answers `Invalid symbol provided` for that symbol — there is no history for a month that has already passed. Each contract block is therefore fetched **independently**: what Fyers still serves is used, what it refuses is recorded and reported as **partial coverage** on the results page (those sessions are absent, not flat). **Refused and empty are kept apart on purpose** — a *refused* block means Fyers rejected the symbol and can never serve it, while an *empty* block means the call succeeded and returned nothing, which is normally a window with no trading days but is **also what an expired token looks like** (Fyers answers `no_data`, not an auth error). So an all-empty run points at the token, never at delisting, and an empty block does not raise the partial-coverage warning though it is still disclosed. If every contract in the range was genuinely refused the run fails with a message naming them and offering the current contract's own window. That window is also the **default range** — the repo-standard 90 days would always open on a dead contract. **Conservative intra-bar ordering**: the stop is tested on the bar's high/low **before** the target, so a bar touching both books the LOSS; a bar that opened beyond a level fills at the **open**. Option P&L is δ+θ simulated seeded at `GAP3M_BT_SEED_PREMIUM=240` plus `GAP3M_BT_SLIPPAGE_PTS=1.5`pt each way.

### Strategy 10: HA SCALP — a no-wick Heikin Ashi candle in the direction of the 50 MA (single-leg slightly-ITM CE/PE, Zerodha)

**Never traded.** Zero paper sessions, zero live orders. Every threshold below is the rule as specified or a round number, not a fitted value.

- **Chart**: **Heikin Ashi** candles built from 15-min NIFTY 50 **spot** bars. `haClose=(o+h+l+c)/4`, `haOpen=(prev haOpen + prev haClose)/2`, `haHigh=max(high,haOpen,haClose)`, `haLow=min(low,haOpen,haClose)`. The chain runs **continuously across days** (`HA_SCALP_HA_CONTINUOUS=true`), which is what TradingView draws — the platform the rules were read off. No decision is taken until `HA_SCALP_HA_WARMUP_BARS=20` bars are behind it, because early HA colours are seed artefacts.
- **Trend gate (hard, directional)**: the `HA_SCALP_MA_PERIOD=50` SMA of **raw** closes. Raw close **above** it → **CE only**; **below** → **PE only**. A perfect bullish candle under a falling MA is *not* a trade — the engine says so in the skip reason rather than silently passing.
- **Entry**: a **"no wick" strength candle** in the trend's own direction — bullish HA with **no bottom wick** for a CE, bearish HA with **no top wick** for a PE. `HA_SCALP_MAX_WICK_PCT=0` means **exactly** wick-free (the wick is measured as a share of the candle's range, so it means the same on a 20pt and a 200pt bar). Body must be ≥ `HA_SCALP_MIN_BODY_PTS=5`. A doji never enters. **Fill is the next candle's open.**
- **Stop**: the **signal candle's own RAW low (CE) / RAW high (PE)** — a frozen level, never trailed. Decisions read the Heikin Ashi candle; **prices read the raw candle**, because an HA price is an average of four numbers and nothing ever traded there.
- **There is NO target.** The trade ends on the stop, a **doji** (body ≤ `HA_SCALP_DOJI_BODY_PCT=20`% of range), a **weak or opposite-colour** candle (body < `HA_SCALP_WEAK_BODY_PCT=40`%), or the `HA_SCALP_FORCED_EXIT=15:15` square-off.
- **Deliberately absent**: no auto-drawn trend line (the 50 MA is the sole trend test — a drawn line depends on which swing points you pick and is not reproducible), no VIX/OI/ADX/RSI/ATR/volume filter, no target, no trail, no breakeven, no partials.
- **Day-level breakers**: `HA_SCALP_MAX_DAILY_TRADES=3`, `HA_SCALP_MAX_DAILY_LOSSES=2` stop-outs, `HA_SCALP_MAX_DAILY_LOSS=3000`, `HA_SCALP_DAILY_PROFIT_LOCK=0` (off), `HA_SCALP_MAX_WEEKLY_LOSS=0` (off), plus the shared portfolio-wide cap.
- **Option**: slightly-ITM (`HA_SCALP_ITM_STEPS=1`, ~delta 0.6). Sizing via `HA_SCALP_LOT_MULTIPLIER` (0 = inherit the global `LOT_MULTIPLIER`; clamped by `MAX_LOT_MULTIPLIER`).
- **How the data arrives.** Closed 15-min spot bars come from the Fyers **history** endpoint, refreshed once per bar `HA_SCALP_HISTORY_LAG_MS=5000` after it closes — the same endpoint the backtest and replay read, which is what makes the four modes agree. On start it preloads `HA_SCALP_WARMUP_DAYS=15` calendar days, because the 50 MA plus the HA chain need ~51 bars and a session is only 25. The **stop is checked on every spot tick** from the shared socket; only the option premium is polled (`HA_SCALP_POLL_MS=2000`).
- **Known risk, measured on real data**: across 6 months of real NIFTY 15-min bars the engine produced 358 signals, and the median stop was 23 spot points — but **23% of stops were under 10 points** (minimum 0.2pt), which is noise-level on a 15-min chart. `HA_SCALP_MAX_SL_PTS` (default `0` = off) exists to reject wide stops, but nothing filters *too-tight* ones; that is the first thing to watch in paper trading.
- **LIVE = PAPER** (`/ha-scalp-live`, [src/routes/haScalpLiveHarness.js](src/routes/haScalpLiveHarness.js)): wraps the Paper engine with the shared harness. **Triple-gated to dry-run**: real orders require `HA_SCALP_LIVE_ENABLED=true` AND `LIVE_HARNESS_DRY_RUN=false` AND `HA_SCALP_LIVE_DRY_RUN` not-true, plus an authenticated **Zerodha** session (Fyers still supplies the candles and premiums). An open position is crash-recovered via `positionPersist` (`.active_ha_scalp_position.json`) and reconciled against the Zerodha book on boot.
- **Backtest** (`/ha-scalp-backtest`, [src/routes/haScalpBacktest.js](src/routes/haScalpBacktest.js)): drives the **same** `getSignal` and re-implements only paper's exits (paper canonical). Warm-up days are prepended to the fetch so the first requested day can trade, but never produce trades themselves. **Conservative intra-bar ordering**: the stop is tested on the bar's high/low **before** any close-based exit, so a bar touching both books the LOSS; a bar that opened beyond the stop fills at the **open**. Option P&L is simulated, seeded at `HA_SCALP_BT_SEED_PREMIUM=240` plus `HA_SCALP_BT_SLIPPAGE_PTS=1.5`pt each way.

### Strategy 11: OI WALL FADE — fade the option wall the writers are still defending (single-leg slightly-ITM CE/PE, Fyers)

**Never traded, and — uniquely here — it can never be backtested.** Zero paper sessions, zero live orders, and no simulated history either: Fyers publishes no *historical* per-strike Open Interest, so there is nothing to run a backtest against and there never will be. Forward-recorded paper sessions are the only evidence about this idea that can ever exist. Every threshold below is a round number, not a fitted value.

**Why an OI strategy at all.** Every other engine here is a trend or breakout engine, so the **sideways day** is the gap they share — on a range day they sit flat or bleed on whipsaws. Per-strike OI is the one input that speaks to a range, because in a range the levels are not drawn by price; they are set by **where the writers are**. Every indicator in this repo (EMA, BB, VWAP, SuperTrend, ATR, RSI) is arithmetic on the same candles and therefore adds no new information. OI is a count of open *positions* published by the exchange, and it does. `optionChainRecorder` was already fetching the ATM±N chain for prices and discarding the `oi` field on every row; [oiChain.js](src/services/oiChain.js) is where it now lands, at **no extra API cost**.

- **Band** — the highest-OI CE strike is the resistance wall, the highest-OI PE strike is the support wall. They must be ≥ `OIWF_MIN_BAND_PTS=150` apart and the candle must **close** inside them. The target is the **mid**-band, so a narrower band cannot pay for the round trip and no tuning fixes that.
- **Pressed** — the just-closed 5-min NIFTY 50 candle must have reached within `OIWF_WALL_NEAR_PTS=30` of a wall (its **high** for the CE wall, its **low** for the PE wall). A wick straight through the wall still counts; that is the setup, not a disqualification.
- **Defended** — that wall's own ΔOI over the last `OIWF_OI_LOOKBACK=3` **OI moves** must be ≥ `OIWF_WALL_BUILD_PCT=2`%. The opposite reading (≤ −`OIWF_WALL_SHED_PCT=2`%) is the **anti-signal**: writers are covering, the wall is giving way, stand aside. An **unknown** ΔOI is a refusal, never a zero — zero reads as "steady", which is a tradeable claim there would be no evidence for.
- **Lookback is in OI MOVES, not minutes.** The recorder polls far faster than OI updates, so `oiChain` only appends a sample when the value actually changes. That makes a Δ comparable across a fast morning and a dead afternoon, at the cost of covering variable wall-clock — hence `OIWF_MAX_OI_SPAN_SEC=1800`, which discards a Δ that took longer than that to accumulate.
- **Rejected** — the same candle must close back on the safe side of the wall: red and below a CE wall, green and above a PE wall. A closed bar from the Fyers history endpoint, so the price half of the decision is exactly reproducible.
- **Direction**: CE wall (resistance) → fade DOWN → **BUY_PE**. PE wall (support) → fade UP → **BUY_CE**.
- **Target** = the mid-band `(ceStrike + peStrike) / 2`. **Stop** = `OIWF_SL_BUFFER_PTS=25` beyond the faded wall's strike. Both are LEVELS, both **frozen into the setup at entry** — the walls move during the day, and a target that tracked them could drift 80 points away from the band the trade was opened on.
- **The geometry to understand before tuning anything.** Target + stop is a fixed span, and where the rejection candle closes decides how it is split. Run on one band with only that close changed, the engine returns R:R from **4.0** (shallow rejection, stop close behind) down to **0.4** (deep rejection into the middle, stop far away). `OIWF_MIN_TARGET_PTS` is the lever and ships **off**.
- **Exits**: wall broken (price stop) → mid-band reached → EOD `OIWF_FORCED_EXIT=15:15`. That is all. **No trail, no breakeven jump, no partial booking, no time stop, no premium stop — and NO OI-based exit.** A wall that starts shedding mid-trade does *not* close the position; its ΔOI at exit is written onto the trade record so the question can be answered from data later, but it does not act.
- **Two guards ship OFF on purpose**: `OIWF_MIN_TARGET_PTS` and `OIWF_REQUIRE_INNER_WALL`, both `0`/`false`.
- **Day-level breakers**: `OIWF_MAX_DAILY_TRADES=3`, `OIWF_MAX_DAILY_LOSSES=2` stop-outs, `OIWF_MAX_DAILY_LOSS=3000`, `OIWF_DAILY_PROFIT_LOCK=0` (off), `OIWF_MAX_WEEKLY_LOSS=0` (off), plus the shared portfolio-wide cap.
- **It refuses to start without an OI feed.** With `OPTION_CHAIN_RECORDER_ENABLED` or `OPTION_CHAIN_RECORD_OI` off the ladder stays empty and this engine has no input at all, so `/oi-wall-fade-paper/start` returns an error naming the setting rather than sitting mute all day looking healthy.
- **How the data arrives.** Closed 5-min **NIFTY 50 index** bars come from the Fyers history endpoint, refreshed once per bar `OIWF_HISTORY_LAG_MS=5000` after it closes. The live index price the two exit levels are tested against comes from the **shared tick socket**, so exits resolve per tick. The option premium is polled every `OIWF_OPT_POLL_MS=2000` for P&L display only — no exit rule reads it.
- **LIVE = PAPER** (`/oi-wall-fade-live`, [src/routes/oiWallFadeLiveHarness.js](src/routes/oiWallFadeLiveHarness.js)): wraps the Paper engine with the shared harness. **Triple-gated to dry-run**: real orders require `OIWF_LIVE_ENABLED=true` AND `LIVE_HARNESS_DRY_RUN=false` AND `OIWF_LIVE_DRY_RUN` not-true, plus an authenticated Fyers session. An open position is crash-recovered via `positionPersist` (`.active_oi_wall_fade_position.json`) and reconciled against the broker book on boot; the wall context is persisted alongside the levels because the ladder itself is in-memory and starts empty after a restart.
- **⚠️ Replay reproduces the candles but NOT the walls.** `chain_oi.jsonl` is recorded, but [tickReplay.js](src/services/tickReplay.js) has no timeline for it, so on a replay every wall reading comes back UNKNOWN and the engine refuses rather than fading blind. That is the safe failure, not a silent one — but it means the usual "diff Paper against Replay before touching a live gate" check is **not available** for this strategy, which raises the bar for going live rather than lowering it. Full OI context is written onto every trade record and skip-log line instead.
- **The core claim is untested**: does a wall whose OI is rising actually hold price, and how far does a rejection off one travel? The read-only [/oi-monitor](src/routes/oiMonitor.js) page and these paper sessions exist to answer exactly that, and the answer may be no.

### Strategy 12: RSI PIVOT ST — RSI extreme + a Standard Pivot R1/S1 break, SuperTrend-stopped (single-leg OTM CE/PE, Zerodha)

**Never traded, and no backtest has been run against it.** Zero paper sessions, zero live orders. Every threshold below is the user's stated rule or a repo convention, not a fitted value. Collect clean paper days and diff them against `/replay` before touching any live gate.

Two levels decide the whole day, and they are fixed before the open. Yesterday's completed **daily** high/low/close give today's classic floor-trader pivots — `PP = (H+L+C)/3`, `R1 = 2·PP − L`, `S1 = 2·PP − H` — and they do **not** move intraday. Only the candles move through them. `R2`/`S2` are computed for the chart and for context; only R1 and S1 are traded.

- **Entry** is evaluated on a **closed** 5-min NIFTY 50 index candle, and both halves are required on that *same* bar — one bar, one decision, no lag between the two tests:
  - **CE** — `RSI(14) > RSI_PIVOT_ST_RSI_CE_MIN=70` **AND** the candle **crosses and closes** above R1: the previous close sat at or below R1 and this one closes above it. A candle already sitting above R1 is **not** a cross — entering there is chasing a move that already happened.
  - **PE** — `RSI(14) < RSI_PIVOT_ST_RSI_PE_MAX=40` **AND** the candle crosses and closes below S1.
  - `RSI_PIVOT_ST_PIVOT_BUFFER_PTS=0` means the close simply has to be beyond the level; raise it to ignore candles that only tickle the line.
- **Strike** — `RSI_PIVOT_ST_STRIKE_MODE=OTM` at `RSI_PIVOT_ST_STRIKE_PCT=1`% of spot. `OTM` shifts *away* from the money (CE above spot, PE below), `ITM` mirrors it, `ATM` ignores the percentage. The raw distance is rounded to the nearest 50-point NIFTY strike, and a percentage that rounds to **zero** steps falls back to ATM rather than inventing a strike.
- **Two stops, each with its own per-side toggle. The defaults keep the original asymmetry: SuperTrend on CE only, premium floor on both.**
  - **SuperTrend** — `SuperTrend(RSI_PIVOT_ST_ST_PERIOD=10, RSI_PIVOT_ST_ST_MULT=2)` on the 5-min **spot** chart, used as both the initial SL and the trail. Applies to `RSI_PIVOT_ST_ST_SIDES=CE` by default; `BOTH`/`PE` mirror it onto the PE side (line **above** price, ratcheting **down**, a flip to *bullish* is the exit). It only ever moves in the trade's favour — a trail that can loosen is not a trail — and a **flip is itself an exit**.
  - **Premium floor** — `RSI_PIVOT_ST_PREMIUM_SL_PCT=25`% below the trade's **high-water** premium, so the floor ratchets up with the position. Applies to `RSI_PIVOT_ST_PREMIUM_SL_SIDES=BOTH` by default.
  - A setup whose SuperTrend is on the wrong side of price, or already at/through the entry close, is **refused** rather than entered with no stop — on whichever side carries the SuperTrend. This is why enabling it on PE makes the PE side trade **less**, not more.
  - **The premium floor's sides are a toggle**: `RSI_PIVOT_ST_PREMIUM_SL_SIDES=BOTH` (default) / `CE` / `PE` / `NONE`. Because PE carries nothing else, excluding PE leaves those trades with **no stop at all** — only the `RSI_PIVOT_ST_EXIT_TIME` square-off closes them, and the whole premium is at risk. That is permitted on purpose, but the paper route, the harness page and the crash-recovery alert all warn about it in red rather than quietly substituting another stop.
- **No profit target at all**, on either side. The trade runs until a stop trails into it or `RSI_PIVOT_ST_EXIT_TIME=15:15` squares it off. **No breakeven jump, no partial booking, no time stop, no re-entry after a stop.**
- **Deliberately absent** (do not "helpfully" add them): VIX gate, OI filter, ADX, volume test, EMA, VWAP, ATR sizing, multi-timeframe bias, extra confirmation candle, expiry-day rule, quality score.
- **Determinism.** Every value the *decision* reads comes from closed 5-min OHLC and the previous day's completed daily bar — never a live tick, never a live spot. The premium stop is the one exception by necessity, because it reads the option LTP; it reads it only for the **exit**, never the entry, and those ticks are recorded so Replay reproduces them.
- **Day-level breakers**: `RSI_PIVOT_ST_MAX_TRADES=5`, `RSI_PIVOT_ST_MAX_DAILY_LOSS=5000`, `RSI_PIVOT_ST_MAX_WEEKLY_LOSS=0` (off), plus the shared portfolio-wide cap. Entries only between `RSI_PIVOT_ST_ENTRY_START=09:30` and `RSI_PIVOT_ST_ENTRY_END=15:00`; the bar's **close** time gates the window, not its start, so the 14:55 bar is still legal.
- **How the data arrives.** Closed 5-min index bars and the daily bars behind the pivots both come from the Fyers **history** endpoint — the same one the backtest and replay read, which is what makes the modes agree — refreshed once per bar `RSI_PIVOT_ST_HISTORY_LAG_MS=5000` after it closes. The daily series is fetched once at session start and **frozen**. The option LTP the premium stop is measured against is polled every `RSI_PIVOT_ST_POLL_MS=2000`, so **that** exit resolves at ~2-second granularity, not per tick.
- **Data from Fyers, orders to Zerodha**, exactly like EMA_RSI_ST — which is why `/rsi-pivot-st-live/start` checks both.
- **LIVE = PAPER** (`/rsi-pivot-st-live`, [src/routes/rsiPivotStLiveHarness.js](src/routes/rsiPivotStLiveHarness.js)): wraps the Paper engine with the shared harness. **Triple-gated to dry-run**: real orders require `RSI_PIVOT_ST_LIVE_ENABLED=true` AND `LIVE_HARNESS_DRY_RUN=false` AND `RSI_PIVOT_ST_LIVE_DRY_RUN` not-true, plus an authenticated Zerodha session.
- **Backtest** (`/rsi-pivot-st-backtest`, [src/routes/rsiPivotStBacktest.js](src/routes/rsiPivotStBacktest.js)): drives the **same** `getSignal` and re-implements only paper's exits (paper is canonical). Two series are fetched — intraday 5-min bars for every decision, and a separate **daily** series, requested from a week *before* the range so the first session still has a yesterday to compute R1/S1 from. **Conservative intra-bar ordering**: the adverse stop is tested on the bar's high/low *before* anything favourable, so a bar touching both books the loss; a bar that opened beyond a level fills at the **open**; entry is the signal bar's close; the SuperTrend trail advances only on a bar **close**, matching paper. **The premium stop is the weakest number in any backtest result** — there is no historical option chain, so the premium is δ+θ simulated seeded at `RSI_PIVOT_ST_BT_SEED_PREMIUM=180` and the 25% floor is applied to *that*, plus `RSI_PIVOT_ST_BT_SLIPPAGE_PTS=2`pt each way.


### SIMPLE_9:30 — the ₹180 option-premium breakout (`src/strategies/simple930.js`)

**Never traded, and never validated.** Zero paper sessions, zero live orders. ₹180, ₹220/₹160 and the 20-point stop are the operator's own numbers, not fitted ones. Collect clean paper days and diff one against `/replay` before touching a live gate.

- **Every decision is an OPTION PREMIUM.** The NIFTY index is read for exactly one thing — the ATM strike sampled once at 09:25 — and for nothing else. There is no spot-chart rule anywhere in the engine.
- **09:25 SELECTION** (`SIMPLE930_SELECTION_TIME`): quote the ladder — the ATM strike plus `SIMPLE930_SCAN_ITM_STRIKES=8` strikes in-the-money per side (CE walks *down*, PE walks *up*), optionally `SIMPLE930_SCAN_OTM_STRIKES=0` the other way — and keep the ONE strike per side trading nearest `SIMPLE930_TRIGGER_PREMIUM=180`. That pair is the watchlist and it is **frozen for the day**: a watchlist that drifted with spot could never be reproduced by replay. A rung that comes back without a price is reported **missing**, never treated as ₹0.
- **ENTRY** between `SIMPLE930_ENTRY_START=09:25` and `SIMPLE930_ENTRY_END=09:35`: the first watchlist leg to trade **strictly above** ₹180 is bought at market. Exactly ₹180 is not a break. Both legs above on the same quote → the one further through the level (an arbitrary "CE first" would bias every such morning to calls). `SIMPLE930_SUSTAIN_POLLS=1` means enter on the first quote above, which is the rule as written.
- **STOP** = `SIMPLE930_SL_PTS=20` below the **ACTUAL FILL**, not below the trigger — filled at 181 → stop 161, filled at 186 → 166, so a slipped fill never buys itself a wider stop. The trail stays **disarmed** until the premium touches the top of the box (`SIMPLE930_TRAIL_ARM_AT_BAND_UP=true`); only then does it trail `SIMPLE930_TRAIL_PTS=20` behind the highest premium seen, ratcheting **up only** and never below the initial stop.
- **09:45 SIDEWAYS EXIT** (`SIMPLE930_SIDEWAYS_CHECK`): a trade still open and still inside `SIMPLE930_BAND_DOWN_OFFSET=20` / `SIMPLE930_BAND_UP_OFFSET=40` either side of the trigger (₹160–₹220 at the defaults) is closed at market, profit or loss. A trade that *did* touch either edge is left alone and runs on the trail to `SIMPLE930_FORCED_EXIT=15:15`. **Honest caveat**: with a 20-point stop the ₹160 edge is unreachable — the stop fires first — so only the ₹220 edge does real work until `SIMPLE930_SL_PTS` is widened.
- **One trade a day** (`SIMPLE930_MAX_DAILY_TRADES=1`). Once it exits, the day is over; the other leg cannot trigger later.
- **Two guards ship OFF on purpose**: `SIMPLE930_MAX_PREMIUM_DIST` and `SIMPLE930_MIN_PREMIUM` both default to `0`. Out of the box the engine does exactly what the rules say — including watching a ₹260 contract on a fresh weekly where the whole ITM ladder sits above the trigger and "breaking ₹180" is meaningless. `MAX_PREMIUM_DIST` exists for that day; it is a lever, not a default.
- **Deliberately absent**: no VIX gate, no OI filter, no ADX/RSI/EMA/VWAP/ATR/SuperTrend, no spot confirmation, no multi-timeframe bias, no confirmation candle, no breakeven jump, no partial booking, no re-entry, no expiry-day rule, and **no `{MODE}_ITM_STEPS` key** — the ₹180 premium *is* the strike rule, so an ITM-steps setting would be a second, contradictory selector.
- **How the data arrives.** Both watchlist premiums are fetched in ONE `fyers.getQuotes` call every `SIMPLE930_POLL_MS=1000`, and every quote — the whole 09:25 ladder included — is written to the tick archive. That is what makes Paper ≡ Live ≡ Replay: replay serves those same recorded premiums back at the replay clock, so even the 09:25 pick is reproducible. A premium the poll has not refreshed for `SIMPLE930_LTP_STALE_MS=15000` is refused as entry evidence rather than filled on. **Exits therefore resolve at ~1-second granularity, not per tick.**
- **Data from Fyers, orders to Zerodha**, like EMA_RSI_ST and RSI Pivot ST — which is why `/simple930-live/start` checks both.
- **LIVE = PAPER** (`/simple930-live`, [src/routes/simple930LiveHarness.js](src/routes/simple930LiveHarness.js)): wraps the Paper engine with the shared harness. **Triple-gated to dry-run**: real orders require `SIMPLE930_LIVE_ENABLED=true` AND `LIVE_HARNESS_DRY_RUN=false` AND `SIMPLE930_LIVE_DRY_RUN` not-true, plus an authenticated Zerodha session. An open position is crash-recovered via `positionPersist` (`.active_simple930_position.json`) — and unlike the frozen-level strategies it persists the **live trail state** (peak, trough, current stop, trail count, whether the box was broken), because without those a restart would wind the stop back to its initial value and re-arm an already-settled 09:45 check.
- **Backtest** (`/simple930-backtest`, [src/routes/simple930Backtest.js](src/routes/simple930Backtest.js)): drives the **same** engine and re-implements only paper's exits. Uniquely in this repo it uses **real 1-minute option premium candles** — there is no δ+θ model, because on a strategy defined entirely on premium that would be simulating the strategy itself. **Conservative intra-bar ordering**: a bar whose high crosses the trigger fills at `max(open, trigger)`; the adverse stop is tested on the bar **low** before the trail is lifted from the bar **high**; a bar that opened beyond the stop fills at the **open**; the entry bar is tested like any other. `SIMPLE930_BT_SLIPPAGE_PTS=1.5` is charged **each way** and Zerodha statutory charges are applied. **How far back it can go is limited by Fyers, not by this code**: a NIFTY weekly option is *delisted the moment it expires*, so in practice only the current expiry week can be fetched. Sessions that cannot be fetched are reported as **"no option data"** per day rather than counted as flat, and `/simple930-backtest/day-log?jobId=…` returns the full per-session audit.
- **Guide**: [documents/SIMPLE930_Strategy_Guide.html](documents/SIMPLE930_Strategy_Guide.html); chart data regenerated with `node tools/genSimple930GuideData.js`. **Tests**: `npm run test:simple930`.


## Quick Start (EC2)

```bash
# 1. Clone / pull code
git clone <repo> trading-bot && cd trading-bot

# 2. Install dependencies
npm install

# 3. Configure
cp .env.example .env
nano .env   # fill in APP_ID, REDIRECT_URL, EC2_IP, Zerodha keys, Telegram

# 4. Generate SSL cert (one-time)
mkdir -p certs
openssl req -x509 -newkey rsa:4096 \
  -keyout certs/key.pem -out certs/cert.pem \
  -days 3650 -nodes -subj "/CN=$(curl -s ifconfig.me)"

# 5. Start
pm2 start src/app.js --name trade

# 6. Auto-start on reboot
pm2 startup && pm2 save

# 7. Open browser
https://YOUR_EC2_IP:3000
```

## Data Storage

All persistent data lives at `~/trading-data/` — **outside the project folder**.
`git pull` and redeployments never wipe your trade history or auth tokens.

```
~/trading-data/
  .fyers_token                    # Fyers OAuth token (daily)
  .zerodha_token                  # Zerodha OAuth token
  paper_trades.json               # EMA_RSI_ST paper trade sessions
  live_trades.json                # EMA_RSI_ST live trade sessions
  bb_rsi_paper_trades.json         # BB_RSI paper sessions
  bb_rsi_live_trades.json          # BB_RSI live sessions
  pa_paper_trades.json            # Price action paper sessions
  pa_live_trades.json             # Price action live sessions
  orb_paper_trades.json           # ORB paper sessions
  orb_live_trades.json            # ORB live sessions
  trend_pb_paper_trades.json      # Trend Pullback paper sessions
  gaps_paper_trades.json          # GAPS paper sessions
  trend_day_scalp_paper_trades.json # Trend Day Scalp paper sessions
  gap_fix_3m_paper_trades.json    # 3M Gap Fix Scalp paper sessions
  ha_scalp_paper_trades.json      # HA Scalp paper sessions
  oi_wall_fade_paper_trades.json  # OI Wall Fade paper sessions
  rsi_pivot_st_paper_trades.json  # RSI Pivot ST paper sessions
  simple930_paper_trades.json     # SIMPLE_9:30 paper sessions
  historical_pnl.json             # One-time P&L baselines per broker (Kite / Fyers)
  nse_holidays.json               # Last good NSE holiday fetch, keyed by year — keeps 2027+ working if NSE blocks the box
  .active_ema_rsi_st_position.json     # Crash recovery — EMA_RSI_ST position
  .active_bb_rsi_position.json     # Crash recovery — bb_rsi position
  .active_pa_position.json        # Crash recovery — PA position
  .active_ema9vwap_position.json  # Crash recovery — EMA9+VWAP position
  .active_orb_position.json       # Crash recovery — ORB position
  .active_trend_pb_position.json  # Crash recovery — Trend Pullback position
  .active_gaps_position.json      # Crash recovery — GAPS position
  .active_trend_day_scalp_position.json # Crash recovery — Trend Day Scalp position
  .active_gap_fix_3m_position.json # Crash recovery — 3M Gap Fix Scalp position
  .active_ha_scalp_position.json  # Crash recovery — HA Scalp position
  .active_oi_wall_fade_position.json # Crash recovery — OI Wall Fade position
  .active_rsi_pivot_st_position.json # Crash recovery — RSI Pivot ST position
  .active_simple930_position.json # Crash recovery — SIMPLE_9:30 position (carries the live trail state)
  .harness_events.json            # Live-harness event log (DRY-RUN/real order events), survives restart
  ema_rsi_st_paper_trades_log.jsonl    # Crash-safe per-trade JSONL audit (cumulative)
  bb_rsi_paper_trades_log.jsonl
  pa_paper_trades_log.jsonl
  orb_paper_trades_log.jsonl
  trend_pb_paper_trades_log.jsonl
  gaps_paper_trades_log.jsonl
  trend_day_scalp_paper_trades_log.jsonl
  trades/                         # Per-day JSONL files: {mode}_paper_trades_YYYY-MM-DD.jsonl
                                  # (one file per strategy per day; seeded with a settings snapshot
                                  #  + checkpoint note, re-snapshotted on every config save)
  ticks/YYYY-MM-DD/               # Replay source: per-day spot / option / VIX / OI ticks + market.jsonl (immutable Market Context Snapshot: expiry/lot/strike-interval/meta)
                                  # (gated by TICK_RECORDER_ENABLED; retention TICK_RECORDER_RETAIN_DAYS)
  _replay_trades/                 # Replay output — snapshot mode (uses session-start settings)
  _replay_trades_sim/             # Replay output — current-settings mode (uses live process.env)
  backtest_cache/                 # Cached historical candles (90-day auto-prune)
  candle_cache/                   # Live candle cache (60-day trim)
  reports/                        # Daily trade reports
  server_logs/YYYY-MM-DD.jsonl    # Server (console) logs, one file per IST day — survives PM2 restarts
                                  # (gated by SERVER_LOG_ARCHIVE_ENABLED; retention SERVER_LOG_RETAIN_DAYS)
```

> Boot-time orphan-position reconciliation now covers **all seven** engines — EMA_RSI_ST, BB_RSI, PA, EMA9+VWAP, ORB, Trend Pullback and GAPS each persist an `.active_*_position.json` snapshot via `positionPersist.js` and are reconciled against broker state on restart. On boot the snapshot is only cleared when the broker book is **provably readable**; an empty/unauthenticated book (expired token or a swallowed API error returning `[]`/`{}`) is treated as "cannot verify" — the snapshot is retained and the user warned to re-check, rather than masking a real orphan. Unverified snapshots are only retained when real orders are possible (harness not dry-run, or a native `*_LIVE_ENABLED`); paper-only boots clear stale snapshots silently.

## Key .env Settings

**The env reference is generated, not hand-written.** See **[docs/ENV.md](docs/ENV.md)** — every
`process.env` key read anywhere in `src/`, with its real default, its type, and the description
from the Settings UI.

```bash
npm run docs:env      # regenerate after adding or removing an env key
npm run docs:check    # exit 1 if it is stale
```

This used to be ~690 lines maintained by hand here, and it had drifted: 71 keys were live in the
code and documented nowhere. Generating it removes that whole class of staleness, and the
generator also reports two things prose never could — engine call sites that disagree on a key's
fallback, and status panels that print a default the engine does not actually use.

Set values through the **[Settings UI](src/routes/settings.js)** (`/settings`) rather than by
editing `.env` directly: saving there also writes a settings snapshot into the day's JSONL trade
log, so each session's trades carry the exact config that produced them.

## Routes

### EMA_RSI_ST
| URL | Description |
|-----|-------------|
| `/` | Dashboard (with Start-All Paper / Start-All Live buttons) |
| `/ema_rsi_st-backtest` | Run backtest (3/5/15-min EMA 20/50+RSI+SuperTrend) |
| `/ema_rsi_st-paper/status` | Paper trade live view + NIFTY chart |
| `/ema_rsi_st-paper/history` | Past paper sessions (per-session delete + view modal) |
| `/ema_rsi_st-paper/simulate` | Market scenario simulator |
| `/ema_rsi_st-live/status` | Live trade status + NIFTY chart (Zerodha; gated by `EMA_RSI_ST_LIVE_ENABLED` + `LIVE_HARNESS_DRY_RUN`) |
| `/tracker/status` | Manual trade tracker |

### BB_RSI
| URL | Description |
|-----|-------------|
| `/bb_rsi-backtest` | BB_RSI backtest (3/5-min BB mean reversion + RSI V8) |
| `/bb_rsi-paper/status` | BB_RSI paper trade + NIFTY chart with BB overlay |
| `/bb_rsi-paper/history` | Past bb_rsi sessions (per-session delete + view modal) |
| `/bb_rsi-paper/simulate` | BB_RSI simulator |
| `/bb_rsi-live/status` | BB_RSI live trade + NIFTY chart |

### Price Action
| URL | Description |
|-----|-------------|
| `/pa-backtest` | PA backtest (5-min patterns) |
| `/pa-pattern-backtest` | Per-pattern attribution backtest (which pattern contributed which P&L) |
| `/pa-paper/status` | PA paper trade + NIFTY chart with swing overlay |
| `/pa-paper/history` | PA sessions (per-session delete + view modal) |
| `/pa-paper/simulate` | PA simulator |
| `/pa-live/status` | PA live trade (legacy code path) + NIFTY chart |
| `/pa-live-harness/status` | PA live via the **paper-wrapping harness** — guarantees LIVE = PAPER decisions. Routes `/start` and `/stop` are gated by `LIVE_HARNESS_DRY_RUN`. |
| `/ema_rsi_st-live-harness` | EMA_RSI_ST live via the paper-wrapping harness (Zerodha orders). `/start` + `/stop` gated by `LIVE_HARNESS_DRY_RUN` (+ `EMA_RSI_ST_LIVE_DRY_RUN`). |
| `/bb_rsi-live-harness` | BB_RSI live via the paper-wrapping harness (Fyers orders). `/start` + `/stop` gated by `LIVE_HARNESS_DRY_RUN` (+ `BB_RSI_LIVE_DRY_RUN`). |
| `/orb-live-harness` | ORB live via the paper-wrapping harness (Fyers orders). `/start` + `/stop` gated by `LIVE_HARNESS_DRY_RUN` (+ `ORB_LIVE_DRY_RUN`). |

### ORB (Opening Range Breakout)
| URL | Description |
|-----|-------------|
| `/orb-backtest` | ORB date-range backtest |
| `/orb-paper/status` | ORB paper trade + ORH/ORL overlay |
| `/orb-paper/history` | ORB sessions (per-session delete + view modal) |
| `/orb-live/status` | ORB live trade (Fyers; gated by `ORB_LIVE_ENABLED` + `LIVE_HARNESS_DRY_RUN`) |

### EMA9 + VWAP
| URL | Description |
|-----|-------------|
| `/ema9vwap-backtest` | EMA9+VWAP date-range backtest |
| `/ema9vwap-paper/status` | EMA9+VWAP paper trade + EMA9/VWAP±σ band overlay |
| `/ema9vwap-paper/history` | EMA9+VWAP sessions (per-session delete + view modal) |
| `/ema9vwap-live` | EMA9+VWAP live via the paper-wrapping harness (Zerodha orders; gated by `EMA9VWAP_LIVE_ENABLED` + `LIVE_HARNESS_DRY_RUN`) |

### Trend Pullback
| URL | Description |
|-----|-------------|
| `/trend-pb-backtest` | Trend Pullback date-range backtest + walk-forward OOS folds + dumb-baseline delta |
| `/trend-pb-paper/status` | Trend Pullback paper trade + NIFTY chart with VWAP/EMA20 overlay |
| `/trend-pb-paper/history` | Trend Pullback sessions (per-session delete + view modal) |
| `/trend-pb-live` | Trend Pullback live via the paper-wrapping harness (Fyers orders; gated by `TREND_PB_LIVE_ENABLED` + `LIVE_HARNESS_DRY_RUN` + `TREND_PB_LIVE_DRY_RUN`) |

### 3M Gap Fix Scalp
| URL | Description |
|-----|-------------|
| `/gap-fix-3m-backtest` | 3M Gap Fix Scalp date-range backtest (front-month futures, rolled like the live path) |
| `/gap-fix-3m-paper/status` | Paper trade — NIFTY FUTURES chart with the gap band, day high/low and bracket, plus the index chart |
| `/gap-fix-3m-paper/history` | Sessions (per-session delete + view modal) |
| `/gap-fix-3m-live` | Live via the paper-wrapping harness (Fyers orders; gated by `GAP3M_LIVE_ENABLED` + `LIVE_HARNESS_DRY_RUN` + `GAP3M_LIVE_DRY_RUN`) |

### HA Scalp
| URL | Description |
|-----|-------------|
| `/ha-scalp-backtest` | HA Scalp date-range backtest (15-min Heikin Ashi, next-candle-open fills) |
| `/ha-scalp-paper/status` | Paper trade — Heikin Ashi chart with the 50 MA and the stop, plus the raw candle chart |
| `/ha-scalp-paper/history` | Sessions (per-session delete + view modal) |
| `/ha-scalp-live` | Live via the paper-wrapping harness (Zerodha orders; gated by `HA_SCALP_LIVE_ENABLED` + `LIVE_HARNESS_DRY_RUN` + `HA_SCALP_LIVE_DRY_RUN`) |

### RSI Pivot ST
| URL | Description |
|-----|-------------|
| `/rsi-pivot-st-backtest` | RSI Pivot ST date-range backtest (5-min index bars + a padded daily series for the pivots; δ+θ premium sim) |
| `/rsi-pivot-st-paper/status` | Paper trade — NIFTY chart with the frozen PP / R1 / S1 levels and the SuperTrend line |
| `/rsi-pivot-st-paper/history` | Sessions (per-session delete + view modal) |
| `/rsi-pivot-st-live` | Live via the paper-wrapping harness (**Zerodha** orders; gated by `RSI_PIVOT_ST_LIVE_ENABLED` + `LIVE_HARNESS_DRY_RUN` + `RSI_PIVOT_ST_LIVE_DRY_RUN`) |

### SIMPLE_9:30
| URL | Description |
|-----|-------------|
| `/simple930-backtest` | SIMPLE_9:30 date-range backtest on **real** 1-min option premium candles. Only reaches back as far as the currently listed weekly contracts — a delisted weekly cannot be fetched at all, and those sessions are reported as "no option data" rather than counted as flat. `/simple930-backtest/day-log?jobId=…` returns the full per-session audit. |
| `/simple930-paper/status` | Paper trade — the 09:25 ladder table, both watchlist legs, a premium chart per leg with the ₹180 trigger / ₹160–₹220 box / stop drawn on it, and a structured decision trail |
| `/simple930-paper/history` | Sessions (per-session delete + view modal) |
| `/simple930-live` | Live via the paper-wrapping harness (**Zerodha** orders; gated by `SIMPLE930_LIVE_ENABLED` + `LIVE_HARNESS_DRY_RUN` + `SIMPLE930_LIVE_DRY_RUN`) |

### Analytics & Tools
| URL | Description |
|-----|-------------|
| `/realtime` | **Unified real-time monitor** — one screen for all enabled strategies with a PAPER/LIVE toggle. Cards for EMA_RSI_ST / BB_RSI / PA / ORB (each card is hidden when its `{STRATEGY}_MODE_ENABLED` is off) showing open position + today's stats, with a rollup table for **Today Total (Open + Closed)**. Read-only; polls each strategy's `/status/data` every 4s. Theme-aware. **Per-card Open Status + Copy Day Log buttons** (Copy Day Log copies raw entry + skip JSONL, not the human-readable summary). Copy Day Log needs the strategy to expose `/download/trades/:date` + `/download/skips/:date`; **ORB now does** (2026-08-04 — it always wrote both day files, it just never served them, so it alone showed "— No Day Log —"). Trend_PB still doesn't. |
| `/replay` | **Tick Replay** — deterministic re-run of a recorded paper session through the paper `onTick()` handlers. Single-date and date-range modes. Snapshot mode (session-start settings) vs current-settings mode (live `process.env`). Per-row diagnostic Replay buttons + downloadable diagnostic dump. Outputs land in `~/trading-data/_replay_trades/` (snapshot) or `_replay_trades_sim/` (current). |
| `/all-backtest` | **Unified backtest dashboard** — runs the same date range across all enabled strategies and renders the per-strategy stats side by side. **🧹 Clear Cache** sits next to Run on **every** backtest page (per-strategy pages included) and wipes the two historical-candle disk caches (`~/trading-data/backtest_cache` + `candle_cache`) so the next run re-downloads from Fyers — use it when a backtest looks like it ran on stale candles. It calls `POST /cache-files/clear-candles`: confirmed once, needs `API_SECRET`, and refused (409) while a backtest is running. Touches no trades and no settings. |
| `/consolidation` | Cross-mode **paper** trade history + analytics (EMA_RSI_ST + BB_RSI + PA, daily/monthly/yearly roll-ups, Day View panel, per-mode breakdown) |
| `/live-consolidation` | Cross-mode **live** trade history + analytics (parity with `/consolidation` for live data) |
| `/consolidation-report` | **Consolidation Report** — a **day-by-day** consolidated report (one table row per trading day), mirroring the Telegram "CONSOLIDATED DAY REPORT" layout: per-strategy trades + P&L columns, then Total / Wins / Losses / Win rate / Net P&L + a 🟢/🔴 result per day, with a totals footer. Book toggle (Paper / Live / **Both**) + a Range preset (**This week / Last week / This month / Last month / Last 7·30 days / This FY / All time / Custom**). A sidebar menu item; the **📈 Edge Analytics** button in its toolbar crosses over to the deeper metrics page. **🖨 Save as PDF** prints through a dedicated `@media print` stylesheet (app chrome hidden, white A4-landscape page, page-break-safe table) — the browser's native print-to-PDF; no external library. Reads the same session files as `/consolidation` + `/live-consolidation`; writes nothing. Gated by `UI_SHOW_EDGE_ANALYTICS`. |
| `/edge-analytics` | **Edge Analytics** — read-only edge dashboard over your recorded trades. Paper/Live book toggle + per-strategy + date-range (This month / Last month / Current week expiry / All / Custom — the same shared set as the Dashboard top bar) filters that recompute instantly client-side. **Headline cards** (trades, win rate, net P&L, expectancy, profit factor, avg win/loss + payoff, max drawdown, win/loss streaks) and a **risk-adjusted row** (Sharpe, Sortino, System Quality/SQN with its Van Tharp grade, recovery factor, Kelly size, edge confidence from a t-test on per-trade P&L, avg hold, cost drag) and an **edge-quality row** (expectancy in R, break-even win rate + the cushion above it, top-5 profit concentration, net excluding those five, equity-curve straightness/R², trades per day, worst run of consecutive red days) — the ratio cards show `—` with *need 10+ days* / *need 20+ trades* until the sample supports them. **Charts**: equity curve, daily P&L, underwater drawdown, P&L-by-hour, P&L-by-weekday, weekday × hour heatmap, monthly P&L grid, P&L distribution, R-multiple distribution, rolling 20-trade form, MFE/MAE heat scatter, and a 1,000-run bootstrap **Monte Carlo** (profitable-run %, median outcome, 1-in-20 bad run, expected max drawdown). **Tables**: By Strategy, By Exit Reason (worst first, to surface the bleed), Nth trade of the day, By Side, By Hold Time, By Signal Strength, By VIX at Entry, plus biggest winners & losers, and a **trade-efficiency** panel (capture %, ₹ left on the table, losers once green, median heat a winner survived). Responsive down to a phone: cards step 8 → 4 → 2 columns, charts shorten, tables and heat grids scroll inside their panel, and safe-area padding keeps the notch clear. Reads the same session files as `/consolidation` + `/live-consolidation`; writes nothing. Not a sidebar item — reached via the **📈 Edge Analytics** button on the Consolidation Report page (gated by `UI_SHOW_EDGE_ANALYTICS_BUTTON`). |
| `/oi-monitor` | **OI Monitor** — read-only live per-strike Open Interest ladder (ATM±N), with the **CE wall** (max-CE-OI strike = resistance) and **PE wall** (max-PE-OI strike = support), the wall band width, whether spot is inside it, and band PCR. ΔOI columns are percent change over the last 1 / 3 / 6 *actual OI moves* (not polls, not minutes — hover for the wall-clock span). Only strikes still inside the polled ATM±N band are shown or counted: the band moves with spot, and a strike it has drifted away from keeps its last OI forever, so an unfiltered ladder would report a morning strike as "the wall" on a trending afternoon. An observation log records, **but never trades**, two opposite readings: `DEFEND` (price pressing a wall whose OI is still rising → writers holding → the range-fade candidate) and `BREAK` (price at that wall while its OI falls → writers running → stand aside). Exists because per-strike OI cannot be backtested — Fyers has no historical-OI API — so the only way to research a range-day wall-fade is to record forward and review. Holds no position, places no order, owns no strategy state. Needs `OPTION_CHAIN_RECORD_OI`; gated by `UI_SHOW_OI_MONITOR` (default off). |
| `/swing-scanner` | **Swing Scanner** — pick one **active** strategy, a timeframe (5m / 15m / 30m / 1h / 4h / 1w) and a stock universe (NIFTY 50 / NIFTY 100 / F&O / your own list), press Search: every stock is run through **that strategy's own `getSignal`** — the same function paper, live and backtest call — and the ones that fire come back ranked. Sortable on every column, with filters for signal side, price band, score, stop % and volume-vs-average. Each **long** row has a **Buy** button that places a **real Zerodha NSE delivery (CNC) MARKET order**; outside market hours it goes out as an **AMO** and Zerodha releases it into the next session's open. The popup takes a quantity, shows the order value, the statutory charges and the total outlay, and needs a second confirmation click; the server ignores the browser's price and re-fetches the LTP and re-derives regular-vs-AMO before sending. Every attempt — placed, rejected or refused — is appended to `~/trading-data/trades/swing_scanner_orders_YYYY-MM-DD.jsonl`. **The timeframe is local to this page**: it does not read or write `TRADE_RESOLUTION` and no running strategy sees it. **The scanner is not an engine** — it holds no position, owns no session, and does not manage what you buy; the stop shown in a row is the strategy's suggestion and is *not* placed at the exchange. Only the four strategies whose rule is a pure function of the candle series are offered (EMA_RSI_ST, BB_RSI, Price Action, RSI Pivot ST) — ORB, GAPS, EMA9+VWAP, Trend Day Scalp, 3M Gap Fix, Trend Pullback and OI Wall Fade need an opening range, a prev-day gap, session VWAP or per-strike OI, none of which are defined on an arbitrary stock timeframe. RSI Pivot ST additionally excludes the weekly bar, since its levels are previous-**day** pivots. Gated by `UI_SHOW_SWING_SCANNER` (default off). |
| `/advisor` | **Settings Advisor** — offline weekly review of your own trade record that names the Settings key to look at. No external service, no API key, no cost: a deterministic rules engine (not an LLM) over the same trade set `/edge-analytics` renders. Checks profit factor, the worst exit-reason bucket, losing entry hours, CE/PE skew, weekday drag, worst day vs the daily-loss cap, intraday loss runs vs the streak brake, and winner-vs-loser holding time. Every finding is sample-gated (a strategy needs `ADVISOR_MIN_TRADES`, a bucket needs 5 trades) and carries the real env keys involved. **Suggests only — never writes a setting.** Book (Paper/Live) + window filters; a weekly snapshot is taken Sunday 08:00 IST to `~/trading-data/.advisor_report.json`. Gated by `UI_SHOW_ADVISOR`. |
| `/pnl-history` | Broker-wise realised P&L (one-time past baselines per broker + auto-computed live-bot P&L by FY) plus a **Manual Trading Analytics** panel below it (Kite/Fyers tabs) for the user's own hand-placed trades — Equity/Options/Futures segment toggle, Year/Month filters, win rate/expectancy/profit-factor/drawdown, and a mistake-pattern scan (revenge trading, oversized losers, overtrading days, cutting winners short vs letting losers run). Past history has no broker API (Kite Connect's `/orders` and `/trades` are today-only — confirmed against the official docs and Kite MCP, which has the identical limit) so it's seeded via a one-time **Kite Console → Reports → Tradebook CSV import** (multi-file select supported; re-importing a file replaces its rows in place rather than skipping them); going forward, today's fills **auto-sync daily at 15:35 IST** (gated by `MANUAL_TRADES_AUTO_SYNC_ENABLED`, default on) or on-demand via **Sync Now**. Fills are FIFO-matched into round-trips per symbol; segment classification trusts the CSV's `segment`/`exchange` column first (symbol-suffix matching alone is unsafe — equity names like RELIANCE end in the letters "CE"). Data stored at `~/trading-data/manual_trades.json`, independent of the bot's own strategy trade logs. |
| `/compare/trading` | Paper vs Backtest comparison (EMA_RSI_ST) |
| `/compare/bb_rsi` | Paper vs Backtest comparison (bb_rsi) |
| `/settings` | All config settings UI + Bulk Edit modal (paste/delete keys) + **checkpoint note prompt on every save** + server restart. Saved notes are appended to that day's trade JSONL alongside a settings snapshot, so the daily log carries the exact config that produced its trades. Hosts the `POST /settings/reset-data` endpoint used by the **Reset Data** dialog on the Logs page. |
| `/trade-logs` | **Renamed from JSONL viewer in v4.5.0.** Per-mode trade-log file manager: per-day trade entries + cumulative skip logs in a separate tab. Top bar has a **🧹 Reset Data** button: a category picker (Paper trade history / Skip trade history / Cache / Logs / Ticks data) with a **select-all** and an optional **date range** — the range deletes matching per-day files (paper/skip daily JSONL + tick day-folders); Cache & Logs always clear fully. Checking **Paper** with **no** date range also fans out to the per-strategy `/reset` routes to restore starting capital + wipe sessions for all 5 strategies (a running strategy is skipped). Posts to `POST /settings/reset-data`. The **Trade Files** and **Skip Logs** tabs each show **one strategy at a time**, picked from a sticky strategy chip bar (each chip carries that strategy's file count; an **All** chip stacks every strategy on one page as before). The pick is remembered per tab; counts come from `GET /trade-logs/counts`. Per-mode **Download All** + **Delete All** buttons, plus a single **Download Everything (all strategies)** button on both the Trade Files and Skip Logs tabs (`/trade-logs/download-everything` and `/trade-logs/skips/download-everything`) that concatenates every mode's daily files into one self-describing JSONL (each line carries its own `mode`). JSONL is the canonical export format (CSV/PDF dropped — they were drifting on edge cases). The **Checkpoints & Settings Changes** tab now has a per-row **↩ Restore** button that reverts a key to its prior value (with a "restore all keys with the same note" checkbox when the entry has a note, and a one-click restart prompt when needed). Light-theme aware. |
| `/cache-files` | Cache / generated-file browser. Groups every on-disk cache by purpose — **Backtest Cache**, **Candle Cache**, **Recorded Ticks**, **Replay Trades** (snapshot + sim), and **Root Data Files** — each with per-file **View** / **Download** / **Delete** plus group **Download All** (`.tar.gz`) + **Delete All**. Read endpoints are open; deletes require `API_SECRET`. Path-traversal-guarded. The canonical trade/skip JSONLs keep their own page (`/trade-logs`); deleting a cache here is safe (regenerated on demand). Gated by `UI_SHOW_CACHE_FILES`. Light-theme aware. |
| `/token-sync` | **Token Sync** — move the day's broker token from the LIVE server to a local machine. Broker OAuth can only complete on LIVE (the redirect URL is registered to that host), but the Fyers/Zerodha *data* APIs work from anywhere, so a token issued on LIVE lets a laptop run **backtests & analytics**. The one-click path is **⇩ Pull tokens from LIVE** (`POST /token-sync/pull`): this machine calls the LIVE server's own `/token-sync/tokens` using `TOKEN_SYNC_LIVE_URL` + `TOKEN_SYNC_LIVE_LOGIN_SECRET` / `TOKEN_SYNC_LIVE_API_SECRET` (each blank = reuse this machine's own `LOGIN_SECRET` / `API_SECRET`) and applies Fyers + Zerodha in one go; `TOKEN_SYNC_ALLOW_SELF_SIGNED` (default `true`) covers LIVE's self-signed cert, a broker LIVE has no token for is skipped not failed, and a token LIVE saved on an earlier day is applied but reported as **stale**. The direction is always local → LIVE → local — LIVE can never push, because a laptop has no address it can reach. Beside it, **🧹 Clear tokens here** (`POST /token-sync/reset`) deletes this machine's `.fyers_token` / `.zerodha_token` and drops them from `process.env` so the next pull starts clean; it touches no other machine and is refused while any engine holds the socket. The manual fallback below it is unchanged. Two blocks: **copy** (this instance's Fyers + Zerodha tokens, masked until 👁 Reveal, with ⧉ Copy and a valid-today / stale badge) and **paste** (`POST /token-sync/apply` writes `~/trading-data/.fyers_token` / `.zerodha_token` stamped with today's IST date and applies it in-process — no restart needed). A **♻ Restart app** button (`POST /token-sync/restart`) is available for `.env` changes; it is refused while **any** engine holds the socket (`isAnyActive`, not just EMA_RSI_ST), and under a plain `npm start` the process stops rather than restarting. Places no orders and touches no trade state. Only the page shell is in `OPEN_PATHS` (a navigation cannot carry the header); `/token-sync/tokens` hands out a live broker credential and so requires `API_SECRET` like the two writes — all three go through `secretFetch`. Gated by `UI_SHOW_TOKEN_SYNC`. Light-theme aware. |
| `/monitor` | EC2 health metrics (CPU, RAM, disk, load average) + maintenance actions |
| `/logs` | Application logs (with SSE live feed; near-miss audit lines visible here). **Copy Log button** in the activity-log header on paLive / paPaper / emaRsiStLive / emaRsiStPaper. Also shown as the **Server Logs** tab on the Logs (`/trade-logs`) page. |
| `/docs` | **Documentation viewer.** Three tabs — README, CHANGELOG and Documents — with per-tab counts in a sticky tab bar. The two markdown files are rendered by [src/utils/markdown.js](src/utils/markdown.js) (block-level: fenced code verbatim with a language badge, real pipe tables in a scroll box, nested lists, blockquotes, anchored headings; `http(s)` links open in a new tab while a repo path renders as a tooltip reference, since no source file is served). An **On this page** rail with scroll-spy lists the README's sections and the CHANGELOG's releases; deep links (`#readme`, `#changelog`, `#documents`, or any heading id) open the tab that owns the target. **Documents** lists `documents/` with a filter box, sort (name / newest / largest), type chip, size, date and per-row Open / Delete — guides for a strategy switched off in Settings are hidden from the list (never from `GET /docs/file/:name`, so bookmarks keep working). Also carries **📦 Sync to Local** (`~/trading-data/` as a `.tar.gz`) and Print. Responsive to 390px; light-theme aware. |
| `/login-logs` | Failed login attempts with geolocation. Shown as the **Login Logs** tab on the Logs (`/trade-logs`) page; still reachable directly. |
| `/deploy/status` | GitHub Actions deploy status |
| `/health` | Health check endpoint |

### Reset Endpoints (per-mode live history)
| URL | Description |
|-----|-------------|
| `POST /settings/reset-data` | Selective data reset used by the **🧹 Reset Data** dialog. Body `{ paper, skip, cache, logs, ticks, from?, to? }` (booleans + optional `YYYY-MM-DD` IST dates). Deletes only the checked categories; the date range filters dated files (paper/skip daily JSONL + tick day-folders) — cache & logs always clear fully. `API_SECRET`-gated. |
| `POST /ema_rsi_st-live/reset` | Clear EMA_RSI_ST live trade history (gated when session active) |
| `POST /bb_rsi-live/reset` | Clear BB_RSI live trade history |
| `POST /pa-live/reset` | Clear PA live trade history |
| `POST /orb-live/reset` | Clear ORB live trade history |

### API Endpoints
| URL | Description |
|-----|-------------|
| `/api/holidays` | NSE holiday list — current year **and** next, with names and per-year source. `?year=YYYY` for one year |
| `/api/holidays/refresh` | Refresh the NSE holiday cache from the API. `?year=YYYY` (defaults to the current year; always warms `year+1` too) |
| `/api/expiry-dates` | NIFTY weekly/monthly expiry calendar — current year **and** next. `?year=YYYY` for one year |
| `/api/cache-info` | Candle cache stats |
| `/auth/status/all` | Combined broker auth status |
| `/sync/info` | Size preview of `~/trading-data/` (used by Sync to Local button) |
| `/sync/download-all` | Streams `~/trading-data/` as a `tar.gz` (server → client) |
| `/backup/status` | Today's snapshot state `{enabled, date, exists, downloaded}` — drives the download-nag banner |
| `/backup/data` | List of on-server snapshots + schedule/retention (Settings card) |
| `/backup/download?date=YYYY-MM-DD` | Streams `backup-<date>.tar.gz` and marks it downloaded |
| `POST /backup/create` | Cut a snapshot for today now |
| `/backup/secrets` | Streams `.env` + `certs/` as `secrets-<date>.tar.gz`. **Requires `API_SECRET`** (returns plaintext keys) — built in memory, never written to disk, never in a snapshot or on Drive |
| `POST /backup/restore` | Upload a `backup-*.tar.gz` (raw body) and restore it over `~/trading-data` + `data/ticks`. Takes a pre-restore safety snapshot first; validates entries against path-traversal; refused while a session is active. Restart after. |
| `/backup/gdrive/status` | Google Drive connection state, last upload, last error (Settings card) |
| `POST /backup/gdrive/credentials` | Save the Google OAuth client (id + secret) into `~/trading-data/.google_drive.json` |
| `POST /backup/gdrive/connect` · `/backup/gdrive/poll` · `POST /backup/gdrive/cancel` | Device-flow connect: returns a user code to approve at google.com/device, then polls until approved |
| `POST /backup/gdrive/disconnect` | Revoke + forget the Google account (stops all uploads) |
| `POST /backup/gdrive/upload` | Push today's snapshot to Drive now (cuts one first if today has none) |

**Off-site copy to Google Drive (optional).** A snapshot sitting on the same EC2 box doesn't survive losing that box. Connect a Google account from **Settings → Backup & Restore → Google Drive** and every daily snapshot is uploaded right after it's cut; disconnected means nothing is uploaded. One-time setup in Google Cloud Console: enable the **Google Drive API**, then in **Google Auth Platform** (the left-menu page that replaced *APIs & Services → OAuth consent screen*) configure the app, **publish** it from **Audience → Publish app** (leaving it in *Testing* expires the connection every 7 days), add the `.../auth/drive.file` scope under **Data Access → Add or remove scopes** (Google only grants scopes registered there — skip it and the connection still succeeds with an email-only token, then the first upload fails with *insufficient authentication scopes*), and create an OAuth client under **Clients** of type **TVs and Limited Input devices** — the app is served from a bare IP with a self-signed cert, so the redirect-based OAuth flow can't be used and it connects via Google's device flow (a code you approve at google.com/device) instead. The scope is `drive.file` only: the bot can only touch files it created, never the rest of your Drive. Credentials and the refresh token live in `~/trading-data/.google_drive.json` (mode 0600) and are **excluded from the backup archive**, so a snapshot never carries them off the box. Upload failures — including from the automatic daily run — are shown as an error strip inside the Backup & Restore card until the next successful push.

**Secrets are a separate download.** Snapshots carry *data* only — `.env` and `certs/` are never in one, precisely because snapshots go to Google Drive and those two hold the broker keys and the TLS private key. But a rebuilt server needs them: `app.js` exits with code 10 on missing certs, and every key lives in `.env`. **Settings → Backup & Restore → 🔑 Download .env + certs** serves them as a one-off `secrets-<date>.tar.gz`, built in memory and streamed straight out — it is never written to disk, so no snapshot or Drive push can ever pick it up. The route requires `API_SECRET` (unlike `/backup/download`, which is open for link navigation), so the UI fetches it with the secret header and saves it as a blob. Store the file privately — a password manager or encrypted drive, *not* Google Drive. To rebuild a box: clone the repo, `tar xzf secrets-YYYY-MM-DD.tar.gz -C <repo>` (restores `.env` and `certs/` with their original modes — `key.pem` stays 0600), restore the data snapshot, then `pm2 startOrRestart ecosystem.config.js --update-env`.
| `POST /{ema_rsi_st|bb_rsi|pa}-paper/history/restore` | Rebuild a deleted session for an IST date by replaying the daily JSONL trade log (idempotent; refuses while paper running) |

## Project Structure

```
src/
  app.js                              # Express server, dashboard, route registration, Start-All
  strategies/
    strategy1_sar_ema_rsi.js          # EMA_RSI_ST strategy (EMA 20/50 (+9 opt) + RSI + SuperTrend) — 5-min default; 15-min via TRADE_RESOLUTION=15
    bb_rsi.js                   # BB_RSI 3/5-min V8 (BB fade + RSI extreme — mean reversion)
    price_action.js                   # Price action 5-min strategy (patterns + S/R + RSI caps + BE trigger)
    orb_breakout.js                   # ORB strategy (15-min opening range; CE/PE single-leg breakout buys)
    index.js                          # Active-strategy registry (currently exposes EMA_RSI_ST; ORB invoked by its own route)
  services/
    backtestEngine.js                 # Historical candle fetch + backtest engine
    tickSimulator.js                  # Market scenario tick generator + historical replay (zigzag ticks)
    tickRecorder.js                   # Spot/option/VIX/OI tick recorder (writes ~/trading-data/ticks/...) for Replay
    vixFilter.js                      # VIX market regime filter
    zerodhaBroker.js                  # Zerodha Kite order placement (EMA_RSI_ST live)
    fyersBroker.js                    # Fyers order placement (bb_rsi + PA + ORB live)
    logger.js                         # Console interceptor + in-memory log store
  routes/
    emaRsiStLive.js                      # EMA_RSI_ST live (5-min default, Zerodha) + chart + /reset endpoint + STRONG_ONLY gate
    emaRsiStPaper.js                     # EMA_RSI_ST paper (5-min default, simulated) + chart + view modal + history JSONL download + STRONG_ONLY gate
    emaRsiStBacktest.js                  # EMA_RSI_ST backtest (5-min default, split-by-years/months)
    bbRsiLive.js                      # BB_RSI live (5-min, Fyers) + chart + BB overlay + /reset endpoint
    bbRsiPaper.js                     # BB_RSI paper (5-min, simulated) + chart + BB overlay
    bbRsiBacktest.js                  # BB_RSI backtest
    paLive.js                         # PA live (legacy code path, Fyers) + chart + swing overlay + /reset endpoint
    paLiveHarness.js                  # PA live via paper-wrapping harness — LIVE = PAPER by construction, gated by LIVE_HARNESS_DRY_RUN
    paPaper.js                        # PA paper (5-min, simulated) + chart + swing overlay + BE trigger
    paBacktest.js                     # PA backtest
    paPatternBacktest.js              # PA per-pattern attribution backtest
    orbLive.js                        # ORB live (Fyers) — gated by ORB_LIVE_ENABLED + LIVE_HARNESS_DRY_RUN
    orbPaper.js                       # ORB paper + ORH/ORL chart overlay
    orbBacktest.js                    # ORB date-range backtest (records option LTP polls so Replay can reproduce)
    replay.js                         # Tick Replay — deterministic re-run of recorded sessions (1-row + date-range)
    allBacktest.js                    # Unified backtest dashboard across all enabled strategies
    manualTracker.js                  # Manual position tracker + SL trailer
    consolidation.js                  # Cross-mode PAPER trade history + Day View + analytics
    liveConsolidation.js              # Cross-mode LIVE trade history + analytics (parity with /consolidation)
    realtime.js                       # Unified real-time monitor (PAPER/LIVE toggle, every enabled strategy on one screen)
    sync.js                           # /sync/info + /sync/download-all (tar.gz of ~/trading-data/)
    pnlHistory.js                     # Broker baselines + live-bot P&L by FY
    compare.js                        # Paper vs Backtest comparison pages
    settings.js                       # Settings UI + Bulk Edit modal (paste/delete keys) + restart endpoint
    monitor.js                        # EC2 health metrics + maintenance actions
    logs.js                           # Log viewer + SSE stream (near-miss audit visible)
    tradeLogs.js                      # Per-mode JSONL viewer (paginated, server-side filtering)
    docs.js                           # README/CHANGELOG/docs viewer (tabs, contents rail, file list)
    auth.js                           # Fyers + Zerodha OAuth
    deploy.js                         # GitHub Actions webhook + status
    loginLogs.js                      # Failed login attempt viewer
    result.js                         # Saved backtest result viewer
  utils/
    markdown.js                       # Markdown → HTML renderer for the /docs README + CHANGELOG tabs
    socketManager.js                  # Fyers WebSocket singleton + fan-out
    sharedSocketState.js              # Mode coexistence manager (EMA_RSI_ST/BB_RSI/PA/ORB aware)
    sharedNav.js                      # Sidebar (accordion) + per-feature menu toggles
    positionPersist.js                # Crash recovery — position save/load (EMA_RSI_ST/BB_RSI/PA only; ORB TBD)
    backtestJobManager.js             # Background backtest job queue (1-at-a-time)
    backtestCache.js                  # Disk cache for historical candles
    candleCache.js                    # Live candle cache
    tradeUtils.js                     # Shared pure helpers for all trade routes
    tradeGuards.js                    # Bid-ask spread guard + time-stop (shared across modes)
    tradeLogger.js                    # Crash-safe JSONL trade-exit log (cumulative + per-day)
    nearMissLog.js                    # Per-filter near-miss audit (logs candles missed by exactly one filter)
    charges.js                        # Brokerage + tax calculator
    nseHolidays.js                    # NSE holiday + expiry API
    notify.js                         # Telegram notifications + crash + startup-recovery alerts (sync on shutdown)
    consolidatedEodReporter.js        # Single combined day report at 15:30 IST
    skipLogger.js                     # Per-day skip-reason log
    resultStore.js                    # Backtest result persistence
    loginLogStore.js                  # Login attempt persistence
    time.js                           # IST time helpers
  config/
    fyers.js                          # Fyers SDK singleton + token management
    instrument.js                     # Strike selection + expiry calculation
```

## Security

- **Login gate**: Cookie-based password (`LOGIN_SECRET`), 15-min sliding expiry, rate limiting (5 attempts/15 min/IP), `SameSite=Lax` cookie for mobile OAuth compatibility, mobile-friendly login flow end-to-end
- **Pre-start broker token verification**: before booting trading engines, Fyers/Zerodha tokens are validated; if stale, the user is bounced to re-login *before* a position can open with a dead token
- **Access token visible after manual login** (with Copy button) for cross-checking against the broker session manager
- **Fyers socket auth failure (code -15)**: bails out + sends a Telegram alert instead of silently retrying
- **API secret**: Token required on all action routes (start/stop/exit/save/reset) and settings page
- **Brute-force logging**: GPS + IP-API geolocation on failed login attempts
- **Crash recovery**: Position state persisted to disk with orphan detection + Telegram alert; SIGTERM handled cleanly to avoid silent restarts
- **Crash + recovery alerts**: Crash-marker file captures error type/stack on uncaught exception → next startup sends Telegram alert with cause and uptime; orphaned positions vs broker reconciled at boot
- **Synchronous Telegram on shutdown**: alerts are sent via `curl` so they survive `process.exit()` and aren't dropped mid-flight
- **Sensitive settings hidden**: `SECRET_KEY`, `ZERODHA_API_SECRET`, `ACCESS_TOKEN`, `ZERODHA_ACCESS_TOKEN`, `TELEGRAM_BOT_TOKEN` are never shown or editable via UI; bulk-edit auto-ignores them too

## Tech Stack

- **Runtime**: Node.js + Express (HTTPS, self-signed cert)
- **Data Feed**: Fyers WebSocket (single connection, multi-mode fan-out)
- **Indicators**: `technicalindicators` (EMA, RSI, ADX, ATR, Bollinger Bands) + SuperTrend from [src/utils/supertrend.js](src/utils/supertrend.js). **Parabolic SAR is no longer computed anywhere** — stripped from EMA_RSI_ST 2026-06-12 and from BB_RSI 2026-07-05; only filenames and comments still carry the name.
- **Brokers**: Zerodha Kite Connect (EMA_RSI_ST live) + Fyers API v3 (bb_rsi + PA live + all data)
- **Notifications**: Telegram Bot API with 17 per-mode toggles + master gate + consolidated EOD
- **Charts**: Chart.js (theme-aware) + live candlestick overlays on status pages
- **Deployment**: PM2 on AWS EC2 t3.micro + GitHub Actions CI/CD
- **Caching**: Disk-based candle cache (backtest + live, auto-pruned)
- **Compression**: gzip middleware on all HTTP responses (≈80% size reduction on `/settings`; ~329 KB → 61 KB)

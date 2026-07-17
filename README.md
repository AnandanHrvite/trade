# Palani Andawar Trading Bot

NIFTY options algorithmic trading bot with **4 independent strategies** (EMA_RSI_ST, BB_RSI, Price Action, ORB), dual-broker architecture (Fyers + Zerodha), background backtesting, paper trading, deterministic **tick-replay** of recorded sessions, after-hours simulation, live NIFTY candlestick charts, consolidated cross-mode analytics (paper + live), per-module dashboard P&L cards, **unified real-time monitor** (one screen for all strategies with a PAPER/LIVE toggle), crash-safe JSONL trade audit, near-miss filter audit, Telegram alerts, and a full web dashboard.

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
| **BB_RSI Live** | BB + SuperTrend + RSI (V7) | 3 / 5-min | Fyers | `/bb_rsi-live` |
| **BB_RSI Paper** | BB + SuperTrend + RSI (V7) | 3 / 5-min | Simulated | `/bb_rsi-paper` |
| **BB_RSI Backtest** | BB + SuperTrend + RSI (V7) | 3 / 5-min | Historical | `/bb_rsi-backtest` |
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
| **Replay** | Re-runs a recorded paper session through the paper `onTick()` | Recorded ticks | Recorded | `/replay` |
| **All Backtest** | Unified backtest dashboard (per-strategy stats) | Per-strategy | Historical | `/all-backtest` |
| **Manual Tracker** | — (trails SL only) | 15-min | Zerodha | `/tracker` |
| **Simulation** | Any (after-hours) | Configurable | Simulated ticks | `/*/simulate` |

> **PA Live (Harness)** runs Live by wrapping the Paper engine and forwarding decisions to a broker harness, so Live = Paper by construction. The legacy `/pa-live` is preserved during the data-collection window for parity comparison.

### Parallel Compatibility

Within each strategy, Live ⊥ Paper (mutual exclusion). Across strategies, every combination is allowed — EMA_RSI_ST, BB_RSI, PA, ORB can run together (paper or live) on the same Fyers socket via [sharedSocketState](src/utils/sharedSocketState.js). Backtests run in a background queue (one at a time) and never block live/paper modes.

The dashboard has **Start-All Paper** and **Start-All Live** buttons that start every enabled mode in sequence with a single click; the two are **mutually locked** (one disables the other and pulses while active) so you never accidentally double-run paper + live across modes. Start-all failures surface in a modal instead of silently reloading.

### Dashboard Layout

- **Per-module cards** (EMA_RSI_ST / BB_RSI / PA) — each card has its own Paper/Live toggle, trades, win-rate, total-P&L, and a cumulative P&L chart. Charts colour green/red by P&L sign.
- **Cumulative P&L card** with a Paper/Live toggle that swaps the data source feeding the per-module charts.
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
- **Trailing**: each candle close, tighten SL to **EMA21** — tighten-only; an EMA21 touch-back is an explicit exit.
- **Exits**: EMA21 trail / EMA touch-back, optional N-bar candle trail (`EMA_RSI_ST_CANDLE_TRAIL_ENABLED`, tighter-of) · **negative-candle stop** (`EMA_RSI_ST_NEG_CANDLE_LIMIT`, default 2 — square off a trade still in the red after N candles) · per-trade points stop (`EMA_RSI_ST_STOP_LOSS_PTS`, off by default) · option-premium stop (`OPT_STOP_PCT`) · opposite signal · exit-before-close (`EMA_RSI_ST_EOD_EXIT_TIME`) · EOD auto-stop (`TRADE_STOP_TIME`). Choppy-day guard: halt entries after `EMA_RSI_ST_MAX_CONSEC_LOSSES` consecutive losers (off by default).
- **Same-side cooldown**: after an SL / option-stop hit, block that side for `EMA_RSI_ST_SL_PAUSE_CANDLES` candles.
- **Opposite-side (flip) cooldown**: after any non-flip exit, block the OPPOSITE side for `EMA_RSI_ST_OPPOSITE_SIDE_COOLDOWN_CANDLES` candles (toggle: `EMA_RSI_ST_OPPOSITE_SIDE_COOLDOWN_ENABLED`). Prevents whipsaw flips on chop. Opposite-signal / EOD / manual exits do not trigger it.
- **Guards kept**: VIX gate, `MAX_DAILY_LOSS`, `MAX_DAILY_TRADES`, trading window, OI buildup gate (live), bid-ask spread guard (live), 0DTE `/start` refusal (blocked when EMA_RSI_ST expiry == today), expiry-day-only, EMA_RSI_ST expiry override/type.
- **Removed**: **Parabolic SAR** — fully stripped 2026-06-12 (SuperTrend is the only trend source; EMA21 the only SL). The `EMA_RSI_ST_USE_SUPERTREND` toggle and the `EMA_RSI_ST_SL_MODE=psar` option are gone. Earlier removals: EMA21-price-touch entry gate + `EMA_RSI_ST_ENTRY_REQUIRE_CROSS` / `_CROSS_TOLERANCE`; EMA30 trend gate, ADX, candle-body, SAR-distance, Logic-3 overrides, STRONG/MARGINAL strength tiers, tiered (T1/T2/T3) trail, hybrid initial-SL cap, 50% candle rule.
- **Chart**: EMA20 (gold) + EMA50 (blue) lines, SuperTrend line (green bullish / red bearish), RSI subplot. EMA values + trend source are recorded per trade in the JSON + daily JSONL (`ema9AtEntry`/`ema20AtEntry`/`ema50AtEntry` + `*AtExit`; `ema9*` populated only when the triple-stack is ON).
- **Resolution-agnostic**: same rules on 3 / 5 / 15-min — set `TRADE_RESOLUTION` in `.env` (or via Settings).

### Strategy 2: BB_RSI — BB + SuperTrend + RSI V7 (3 / 5-min)
See [BB_RSI.md](BB_RSI.md) for the authoritative spec. Summary:
- **Entry (at candle close, all required)** — **CE**: close ≥ BB upper **and** SuperTrend bullish (line below close) **and** RSI > `BB_RSI_RSI_CE_THRESHOLD(70)`. **PE**: close ≤ BB lower **and** SuperTrend bearish (line above close) **and** RSI < `BB_RSI_RSI_PE_THRESHOLD(40)`. Just the two RSI keys — no overbought/oversold caps. **Trend source** is SuperTrend(10,3) — it drives the directional confirm, the entry SL line **and** the flip exit (period/multiplier via `BB_RSI_SUPERTREND_PERIOD` / `BB_RSI_SUPERTREND_MULT`). **Far-line filter**: skip if the SuperTrend line is more than `BB_RSI_MAX_ENTRY_SL_PTS(50)` pts from close (avoids uncapped-risk entries). **ADX trend filter** (optional, `BB_RSI_ADX_ENABLED`): block all entries when ADX(14) < `BB_RSI_ADX_MIN(20)` — sits out choppy/ranging sessions where the strategy bleeds.
- **Confirmation candle** (`BB_RSI_CONFIRM_CANDLE_ENABLED`, default on): the bar meeting the entry rules is the *signal candle*; entry does **not** fire on its close. The **immediately-next** candle must cross the signal candle's close (CE above / PE below) — entry then fires intra-bar on the cross. Off = legacy entry at the signal candle's close.
- **Confirmation must close outside band** (`BB_RSI_CONFIRM_OUTSIDE_BAND`, default on; needs confirmation candle on): the confirmation candle must **close** beyond the signal candle's close **and** close **outside the Bollinger band** — entry then fires at that close. An intra-bar poke past the trigger can close back *inside* the band (a failed breakout), which leaves the entry candle sitting visibly inside the band; requiring a close beyond the band makes every entry candle genuinely outside it. Off = enter intra-bar on the first cross of the signal candle's close (legacy).
- **Guards**: optional `BB_RSI_RSI_TURNING`, independent VIX filter.
- **Indicators**: Bollinger Bands `20 / 1` (std-dev **1**), RSI(14), SuperTrend `10 / 3`.
- **Initial SL** = SuperTrend value at entry (no clamp). Used for risk sizing + display; it is **not** an intra-tick stop and does not trail.
- **Exit** (per-tick, **spot points**): **Profit lock** — once peak favourable spot move ≥ `BB_RSI_PROFIT_LOCK_TRIGGER_PTS(25)`, exit when it gives back below `BB_RSI_PROFIT_LOCK_PCT(50)`% of peak (ratchets up: peak 100pts → lock 50pts); the upside exit. → **Hard stop** — exit if the trade moves ≥ `BB_RSI_STOP_LOSS_PTS(30)` against entry; a **wide** catastrophic loss cap that only clips deep adverse excursions on failed fades (the shown SuperTrend SL is display/sizing only). Both points-based so they work even on spot-proxy sessions. → **BB re-entry** (per-tick): exit the instant spot crosses back through the band (failed breakout), at the band line — not the bar close (`BB_RSI_BB_REENTRY_EXIT`, default on); armed only once the breakout has extended ≥ `BB_RSI_BB_REENTRY_ARM_PTS(10)` past the band, so a fresh entry sitting right at the band isn't knocked out by an immediate noise wick → **trend flip** on candle close (SuperTrend flip) handles trend runners → bid-ask spread guard → EOD. No break-even-to-entry snap, no SuperTrend/prev-candle SL trail, no % spot-trail, no time-stop.
- **Per-side SL pause** (`BB_RSI_PER_SIDE_PAUSE`): an SL on CE only pauses CE entries; PE remains free, plus `BB_RSI_CONSEC_SL_EXTRA_PAUSE` extra candles per consecutive SL.
- **Per-trade context logging** (additive): each trade record captures BB / RSI / trend context at entry and **MFE / MAE** (max-favorable + max-adverse excursion in pts and ₹) over the life of the trade, **`secsToMFE` / `secsToMAE`** (seconds from entry to that peak / trough — distinguishes early-peak-then-giveback from slow-grind, for trail tuning), plus **`vixAtExit`** — feeds the active paper-trade data-collection schema. This enrichment is now uniform across all 4 strategies (paper + live): each logs the signal diagnostics it computes at entry (EMA_RSI_ST: EMA9/slope/RSI/SAR/ADX; PA: RSI/ADX/trend/pattern/SR; ORB: VWAP-aligned/vol/wick pass flags) so post-window analysis can correlate behaviour with market conditions. Timing fields use each engine's replay-safe tick clock so replayed sessions reproduce identical values

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
- **Entry Engine V3 — Trend-Day** (`ORB_ENTRY_V3_ENABLED=true`, **default**; 2026-07-10 redesign in [src/strategies/orb_breakout.js](src/strategies/orb_breakout.js)). Goal: **capture trend days and kill false breakouts, not trade more.** Built for slightly-ITM (~delta 0.6) weekly options. The 09:15–09:30 opening range is **frozen** after 09:30 and never recomputed. Every threshold is **ATR-relative** so the gates hold across VIX regimes. A trade requires **all** of the following, in order:
  1. **Adaptive OR-size** — skip the day unless OR width is `ORB_OR_ATR_MIN=0.7` … `ORB_OR_ATR_MAX=2.5` × `ATR(15m)` (`ORB_ATR_PERIOD=14`). Too tight = chop; too wide = the open already ran. (Fails open until ATR15 is seeded.)
  2. **Gap sanity** — skip the day when `|today open − prior close| > ORB_GAP_OR_MULT=3 × OR width` (exhaustion / news gap). Fails open when the prior close isn't in the window.
  3. **Break into fresh ground** (`ORB_PRIORDAY_LEVEL_FILTER=true`) — the breakout must also clear the **prior day's High** (CE) / **Low** (PE): trapped traders provide fuel and there's a real stop below. Most restrictive gate; turn off if it blocks too many days.
  4. **Breakout beyond a buffer** — the **first** 5-min close to clear the OR edge by `max(ORB_BUFFER_OR_MULT=0.15×OR, ORB_BUFFER_ATR_MULT=0.3×ATR5, 1pt)` is the *one committed breakout* of the day (no second attempt).
  5. **Breakout-candle quality** (on that candle): green/red in the trade direction, body ≥ `ORB_BODY_ATR_MULT=0.6 × ATR(5m)` (a decisive bar), close within the top/bottom `ORB_CLOSE_POS_PCT=0.25` of the candle, and close on the correct side of session VWAP (`ORB_VWAP_FILTER_ENABLED`). The old V2 EMA20/50 + ADX + RSI + EMA-slope stack is **removed** — correlated filters that clipped the right tail (see the 2026-07-10 audit).
  6. **One confirmation candle** (`ORB_CONFIRM_ENABLED=true`) — **do not buy the breakout candle.** Primary entry is the *next* candle if it extends the move (higher-high + higher-close beyond the edge, still on the right side of VWAP). This early entry is what keeps trend days.
  7. **Optional, NON-BLOCKING retest** (`ORB_RETEST_MODE=optional`) — only a fallback for when the confirmation candle hesitates: within `ORB_RETEST_MAX_WAIT=4` candles, enter on a fresh trend-resume, on a pullback that retests the edge and holds (tol `max(ORB_RETEST_TOL_MIN=5, ORB_RETEST_TOL_PCT=0.1×range)`), or on the window-end if still trending. A move that never retests **still enters** — the retest can never veto a trend. Set `off` for confirmed-breakout entry only. (A *mandatory* retest measurably hurt expectancy in the 2026-07-09 backtest, which is why it is never required.)
  8. **Option filter (STEP 8)**: slightly-ITM strike (`ORB_ITM_STEPS=1`, CE lower / PE higher; 0 = ATM), option LTP inside `[ORB_PREMIUM_MIN=120, ORB_PREMIUM_MAX=400]` (`ORB_PREMIUM_GATE_ENABLED`), bid-ask spread ≤ `ORB_MAX_SPREAD_PTS=2` (falls back to the global `MAX_BID_ASK_SPREAD_PTS`; fails open when the snapshot has no depth). Live/paper only — the backtest has no option chain.
  9. **One trade/day** (`ORB_MAX_DAILY_TRADES=1`): a failed confirmation does **not** trigger a second breakout attempt. Window `ORB_RANGE_END=09:30` → `ORB_ENTRY_END=11:30`.
  - Entry is on the **confirmation / retest candle's close**; the route sets the initial hard SL from that candle's own low (CE) / high (PE). ATR(5m)/ATR(15m) + prior-day H/L are seeded from a multi-day preload (paper/live keep ~300 bars; the backtest feeds `getSignal` a trailing `ORB_SIG_WINDOW=260`-bar window), while the OR + VWAP stay day-scoped so prior days never leak in.
- **Legacy engines**: `ORB_ENTRY_V3_ENABLED=false` falls back to **V2** (`ORB_ENTRY_V2_ENABLED`, confirmed-breakout with the EMA/ADX/RSI stack) and then **V1** (immediate-entry: `ORB_WICK_FILTER_ENABLED`, `ORB_VOL_FILTER_ENABLED`, sweet-spot tiering). Kept for A/B / rollback. The `ORB_RETEST_ENABLED` backtest gate is V2-only and is ignored under V3. **VIX gate** (`ORB_VIX_ENABLED`), **OI gate** (`ORB_OI_ENABLED`, now applied in paper **and** live), and **expiry-day-only** (`ORB_EXPIRY_DAY_ONLY`) apply to all engines.
- **Exit — trend-following model** (unchanged shape; lets the right tail run):
  - **Initial hard SL** = the entry candle's own low (CE) / high (PE).
  - **Adaptive breakeven** (`ORB_BREAKEVEN_PTS=20` floor, `ORB_BREAKEVEN_OR_MULT=0.5`): once the trade is `max(20, 0.5×OR)` NIFTY pts in profit, the hard SL lifts to entry — a wide-range day gets more room.
  - **EMA trend-trail** (`ORB_TRAIL_EMA=20`): exit only when a candle **closes back across** the EMA (of 5-min closes) — a winner rides the whole trend instead of being shaken out by one pullback. Seeded from prior-day candles so it is live even for a 09:35 entry. **No fixed target** (`ORB_TARGET_RANGE_MULT` is an informational chart line only).
  - **Strong opposite candle** (`ORB_OPP_CANDLE_EXIT=true`, `ORB_OPP_CANDLE_BODY_MULT=0.3`): exit when a candle closes against the trade with body ≥ 0.3×OR width, back inside the box.
  - **Per-trade caps**: `ORB_MAX_TRADE_LOSS=1500` (unrealised-₹) and `ORB_PREMIUM_STOP_PCT=35` (option premium collapses ≥35% from entry — catches IV-crush/vega losses). Whichever of these / the spot SL fires first.
- **Risk caps**: 1 trade/day default (`ORB_MAX_DAILY_TRADES=1`), `ORB_MAX_DAILY_LOSS=3000` (daily kill, checked only when flat). **Portfolio breaker** (`ORB_RISK_THROTTLE_ENABLED=true`, persisted at `~/trading-data/orb_risk_state.json`, paper/live tracked separately): sit out entries after a weekly-loss stop (`ORB_MAX_WEEKLY_LOSS=9000`, ISO Mon→Fri) or `ORB_LOSS_STREAK_SKIP=4` consecutive losing days (one-day cool-off). Forced square-off at `ORB_FORCED_EXIT=15:15`, last entry `ORB_ENTRY_END=11:30`.

### Strategy 5: EMA9 + VWAP — EMA 9 crosses the VWAP ±σ band (5-min, Zerodha)
- **Signal source** ([src/strategies/ema9_vwap.js](src/strategies/ema9_vwap.js)): EMA 9 (on 5-min close) vs a **session-anchored VWAP with Standard-Deviation bands** — source HLC3, multiplier `EMA9VWAP_BAND_MULT=1` (= ±1σ, the TradingView default). Set the multiplier to `0` to collapse the band to the plain VWAP line.
- **Entry** (evaluated on candle CLOSE): **CE** when EMA 9 crosses **above** the top line (`VWAP + mult·σ`); **PE** when EMA 9 crosses **below** the bottom line (`VWAP − mult·σ`). Window `EMA9VWAP_ENTRY_START=10:30` → `EMA9VWAP_ENTRY_END=14:30`.
- **Exit — PURE signal exit**: hold the FULL position (no stop-loss / target / trail) until EMA 9 crosses back **inside** the band (CE → back below the top line, PE → back above the bottom line). A trailing position runs past 14:30; hard EOD square-off at `EMA9VWAP_EOD_EXIT_TIME=15:15`. Optional catastrophe stops (`EMA9VWAP_OPT_STOP_PCT`, `EMA9VWAP_STOP_LOSS_PTS`) default **off**.
- **Exit — 2-candle reversal engulf** (`EMA9VWAP_REVERSAL_EXIT_ENABLED`, default **on**): on candle close, square off immediately if the just-closed candle reverses hard against the position — a CE bails on a **bearish** candle (`close < open`) that closes **below both** of the previous 2 candles' lows; a PE on a **bullish** candle that closes **above both** of the previous 2 candles' highs. Rolling reference (each closed candle vs its own prior 2). Turn off to hold purely to the signal / EOD exit.
- **Note**: NIFTY spot has no real volume, so this VWAP is effectively a session **TWAP±σ** (HLC3) — same caveat as ORB's VWAP filter. The σ-band math and the EMA9 cross are exact; absolute VWAP values track TradingView's shape but are not tick-identical.
- **Guards**: the VIX gate uses the **GLOBAL** `VIX_*` keys (no per-mode key — `VIX_FILTER_ENABLED` on by default, block > `VIX_MAX_ENTRY=20`); OI-buildup + bid-ask-spread guards are live-only. Risk caps `EMA9VWAP_MAX_DAILY_TRADES=20` / `EMA9VWAP_MAX_DAILY_LOSS=5000` (fall back to the global `MAX_DAILY_*`). Circuit breakers: 3 consecutive losses → 5-min pause (4 candles) / 15-min daily kill; optional chop guard `EMA9VWAP_MAX_CONSEC_LOSSES` (0=off). Cooldowns: same-side SL cooldown `EMA9VWAP_SL_PAUSE_CANDLES=3` (inert unless an optional stop fires) + opposite-side flip cooldown `EMA9VWAP_OPPOSITE_SIDE_COOLDOWN_ENABLED=true`/`_CANDLES=3` after a signal-cross or reversal exit.
- **LIVE = PAPER**: `/ema9vwap-live` runs the paper engine and places **Zerodha** orders via the harness, double-gated by `EMA9VWAP_LIVE_ENABLED` + `LIVE_HARNESS_DRY_RUN`. Backtest is a dedicated candle-loop engine ([src/services/ema9vwapBacktestEngine.js](src/services/ema9vwapBacktestEngine.js)) that mirrors the paper decisions exactly. Runs in parallel with the other strategies on the shared Fyers socket.

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

### Tick Replay — deterministic re-run of recorded sessions
- Every paper/live session records spot, option (incl. entry-time bid/ask), VIX, and futures-OI ticks to `~/trading-data/ticks/YYYY-MM-DD/*.jsonl` when `TICK_RECORDER_ENABLED=true` (default; pure observer, no trade-path impact). OI is recorded only while an OI filter is enabled. Retention: `TICK_RECORDER_RETAIN_DAYS=30`.
- `/replay` re-runs a recorded session through the same paper `onTick()` handlers to produce **bit-identical** results.
- Two modes: **Snapshot mode** uses the session-start settings snapshot from that day's JSONL → identical output every run; **Current-settings mode** uses the live `process.env` so you can A/B settings changes against real ticks after hours.
- Outputs land in `~/trading-data/_replay_trades/` (snapshot) or `_replay_trades_sim/` (current-settings) — kept separate from the canonical paper logs.
- Date-range replays loop per session and render a per-row table with one-click re-runs.

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
  historical_pnl.json             # One-time P&L baselines per broker (Kite / Fyers)
  .active_ema_rsi_st_position.json     # Crash recovery — EMA_RSI_ST position
  .active_bb_rsi_position.json     # Crash recovery — bb_rsi position
  .active_pa_position.json        # Crash recovery — PA position
  .harness_events.json            # Live-harness event log (DRY-RUN/real order events), survives restart
  ema_rsi_st_paper_trades_log.jsonl    # Crash-safe per-trade JSONL audit (cumulative)
  bb_rsi_paper_trades_log.jsonl
  pa_paper_trades_log.jsonl
  orb_paper_trades_log.jsonl
  trend_pb_paper_trades_log.jsonl
  trades/                         # Per-day JSONL files: {mode}_paper_trades_YYYY-MM-DD.jsonl
                                  # (one file per strategy per day; seeded with a settings snapshot
                                  #  + checkpoint note, re-snapshotted on every config save)
  ticks/YYYY-MM-DD/               # Replay source: per-day spot / option / VIX / OI tick recordings
                                  # (gated by TICK_RECORDER_ENABLED; retention TICK_RECORDER_RETAIN_DAYS)
  _replay_trades/                 # Replay output — snapshot mode (uses session-start settings)
  _replay_trades_sim/             # Replay output — current-settings mode (uses live process.env)
  backtest_cache/                 # Cached historical candles (90-day auto-prune)
  candle_cache/                   # Live candle cache (60-day trim)
  reports/                        # Daily trade reports
```

> ORB does not yet have an `.active_orb_position.json` crash-recovery file — orphan-position reconciliation on boot covers EMA_RSI_ST/BB_RSI/PA only. Add to `positionPersist.js` if/when ORB needs restart-survival of an open position.

## Key .env Settings

### EMA_RSI_ST Strategy (EMA 20/50 (+9 opt) + RSI + SuperTrend, Zerodha)
**Entry redefined 2026-05-31; PSAR stripped 2026-06-12; close-beyond-EMA gate added 2026-06-24.** Entry (intra-candle, all 4 true): **CE** = EMA alignment bullish (2-EMA default: EMA20 above EMA50; or triple-stack `EMA_RSI_ST_EMA_TRIPLE_STACK_ENABLED`: EMA9 > EMA20 > EMA50 via `EMA_RSI_ST_EMA_FASTEST`/`EMA_RSI_ST_EMA_FAST`/`EMA_RSI_ST_EMA_SLOW`), RSI(14) `> RSI_CE_MIN` and `< RSI_CE_MAX`, **SuperTrend bullish**, **signal candle close above the base EMA** (`EMA_RSI_ST_CLOSE_BEYOND_EMA_ENABLED`, default on — base = EMA-fastest/9 when triple-stack on, else EMA-fast/20). **PE** = mirror (EMA20 below EMA50 / EMA9 < EMA20 < EMA50, RSI `< RSI_PE_MAX` and `> RSI_PE_MIN`, **SuperTrend bearish**, signal candle close below the base EMA). **Stop** = initial SL is the previous candle low (CE) / high (PE) from `getSignal`, then trailed by **EMA21** (EMA touch-back is an explicit exit), tighten-only. Optionally layer an **N-bar candle trail** (`EMA_RSI_ST_CANDLE_TRAIL_ENABLED` / `EMA_RSI_ST_CANDLE_TRAIL_BARS`, default 3 bars): each candle close the stop is set to whichever is tighter — the EMA21 line or the N-bar low/high. **Exits**: trail SL · **negative-candle stop** (`EMA_RSI_ST_NEG_CANDLE_LIMIT`, default 2 — still red after N candles → square off; winners keep riding the trail) · per-trade points stop (`EMA_RSI_ST_STOP_LOSS_PTS`, off by default) · EMA21 touch-back · option stop (`OPT_STOP_PCT`) · opposite signal · exit-before-close (`EMA_RSI_ST_EOD_EXIT_TIME`) · EOD auto-stop. Same-side cooldown after an SL hit (`EMA_RSI_ST_SL_PAUSE_CANDLES`). **Choppy-day guard** (`EMA_RSI_ST_MAX_CONSEC_LOSSES`, off by default): after N consecutive losing trades in a session, halt new entries for the rest of the day — any winner resets the streak. _Parabolic SAR fully removed 2026-06-12 (SuperTrend is the only trend source; EMA21 the only SL); breakeven removed 2026-06-02._

> **Defaults below are the code `||` fallbacks (what runs if the env key is unset). The Settings UI seeds more conservative values that a saved install actually runs** — notably `MAX_DAILY_TRADES=5`, `MAX_DAILY_LOSS=3000`, `RSI_CE_MAX=70` / `RSI_PE_MIN=30`, `EMA_RSI_ST_STOP_LOSS_PTS=25` (ON), `EMA_RSI_ST_CANDLE_TRAIL_ENABLED=true` (ON), `EMA_RSI_ST_SL_PAUSE_CANDLES=2`, `EMA_RSI_ST_OPPOSITE_SIDE_COOLDOWN_CANDLES=2`, `EMA_RSI_ST_EOD_EXIT_TIME=14:30`, `TRADE_ENTRY_START=10:30`. Read the real config from the day's `settings_snapshot`, not this table.

| Key | Default | Notes |
|-----|---------|-------|
| `TRADE_RESOLUTION` | `5` | Candle size in minutes — `3`, `5`, or `15` (logic is resolution-agnostic). |
| `MAX_DAILY_LOSS` | `5000` | Daily kill-switch in INR (per-strategy) |
| `PORTFOLIO_MAX_DAILY_LOSS` | `0` (off) | **Portfolio-wide** daily loss cap in INR across ALL strategies (sums today's realized paper P&L via the per-day JSONL logs). When the book's combined loss reaches this, every strategy stops taking new entries for the day. Fail-safe (only blocks, never places orders). `0`/unset = disabled. |
| `MAX_DAILY_TRADES` | `20` | Daily entry cap — anti-overtrade on chop days. *(Settings UI seeds a tighter `5`.)* |
| `EMA_RSI_ST_LIVE_ENABLED` | `false` | Must be `true` AND `LIVE_HARNESS_DRY_RUN=false` for real Zerodha orders. When `LIVE_HARNESS_DRY_RUN=true` (default), EMA_RSI_ST Live logs the broker calls it would make (entry, hard-SL, trail, exit) but places none. |
| `BACKTEST_OPTION_SIM` | `true` | Realistic option P&L (delta x theta) |
| `RSI_CE_MIN` | `52` | CE entry: RSI(14) must be above this (bullish momentum floor) |
| `RSI_CE_MAX` | `80` | CE blocked when RSI at/above this (overbought guard) |
| `RSI_PE_MAX` | `48` | PE entry: RSI(14) must be below this (bearish momentum cap) |
| `RSI_PE_MIN` | `20` | PE blocked when RSI at/below this (oversold guard) |
| `EMA_RSI_ST_EMA_FAST` | `20` | Fast/mid EMA period (close). 2-EMA mode: CE needs EMA-fast above EMA-slow; PE below. Triple-stack: this is the MID EMA. |
| `EMA_RSI_ST_EMA_SLOW` | `50` | Slow EMA period (close). The EMA-fast vs EMA-slow alignment is the directional entry gate. |
| `EMA_RSI_ST_EMA_TRIPLE_STACK_ENABLED` | `false` | Stricter EMA gate. `false` = 2-EMA cross. `true` = require EMA-fastest > EMA-mid > EMA-slow (CE) / reverse (PE) — the fast EMA must confirm too. Cuts marginal cross-over chop entries (skip logs show it blocks flat-EMA bars the 2-EMA gate would take). A/B via `/replay` before enabling live. |
| `EMA_RSI_ST_EMA_FASTEST` | `9` | Fastest EMA period (close) in the 9>20>50 stack. Only used when `EMA_RSI_ST_EMA_TRIPLE_STACK_ENABLED=true`. |
| `EMA_RSI_ST_CLOSE_BEYOND_EMA_ENABLED` | `true` | **Close beyond base EMA.** `true` (default): the signal candle's **close** must sit on the trade side of the base EMA — **CE close above, PE close below**. Base EMA = EMA-fastest (`EMA_RSI_ST_EMA_FASTEST`, 9) when `EMA_RSI_ST_EMA_TRIPLE_STACK_ENABLED=true`, else EMA-fast (`EMA_RSI_ST_EMA_FAST`, 20). The EMA-stack gate only checks EMA *ordering*; this blocks buying CE into dips that close below the fast EMA while the lines stay stacked from an earlier move (the false-breakout chop that bleeds prev-candle stops). `false` = ordering-only gate. A/B via `/replay`. |
| `EMA_RSI_ST_CONFIRM_CANDLE_ENABLED` | `true` | **Confirmation candle (cross & close).** `true` (default): a fully-closed candle must meet all entry rules (the *signal candle*), then the **immediately-next** candle must cross that signal candle's close (CE above / PE below) — entry fires **intra-bar** on the cross. `false`: legacy intra-candle entry (enter as soon as the live bar meets the rules). Filters one-candle false breakouts. A/B via `/replay`. |
| `OPT_STOP_PCT` | `0.15` | Exit if option premium drops this fraction below entry premium (0.15 = 15%) |
| `EMA_RSI_ST_NEG_CANDLE_LIMIT` | `2` | Negative-candle stop — if a trade is still in the red (option premium below entry) at the close of this many candles, square it off. Asymmetric loss-cut: winners keep riding the EMA trail; losers don't bleed across the chop. `0` = disabled. |
| `EMA_RSI_ST_STOP_LOSS_PTS` | `0` | Per-trade catastrophic loss cap — exit if spot moves this many points against entry. Checked before the structural/trail SL, so it caps deep adverse excursions when the prevHigh/prevLow stop sits wider than the cap. Points-based (mirrors `BB_RSI_STOP_LOSS_PTS`). `0` = disabled. |
| `EMA_RSI_ST_MAX_CONSEC_LOSSES` | `0` | Choppy-day guard — after this many **consecutive losing trades** in a session, halt new EMA_RSI_ST entries for the rest of the day; any winning trade resets the streak. Sits out range days that bleed small stops instead of repeatedly re-entering. Independent of the legacy 3-loss escalating pause. `0` = disabled. |
| `EMA_RSI_ST_CANDLE_TRAIL_ENABLED` | `false` | Layer an N-bar candle trail on top of the EMA21 SL. Each candle close the stop is set to whichever is **tighter** (closer to price) — the EMA21 line or the N-bar low (CE) / high (PE). Banks more of a winner; never loosens. |
| `EMA_RSI_ST_CANDLE_TRAIL_BARS` | `3` | Lookback for the candle trail: lowest low (CE) / highest high (PE) of the last N candles. `1` = tightest; higher = looser (gives winners room, fewer chop stop-outs). Only used when `EMA_RSI_ST_CANDLE_TRAIL_ENABLED=true`. |
| `EMA_RSI_ST_BREAKEVEN_ENABLED` | `false` | Once a trade is `EMA_RSI_ST_BREAKEVEN_PTS` in profit (spot), raise the stop to the entry price (tighten-only) so a winner can't turn into a loss. Applies to paper, live, and backtest identically. Off by default — validate on backtest/replay before enabling. |
| `EMA_RSI_ST_BREAKEVEN_PTS` | `25` | Profit in spot points that arms the breakeven floor. Only used when `EMA_RSI_ST_BREAKEVEN_ENABLED=true`. |
| `EMA_RSI_ST_SUPERTREND_PERIOD` / `EMA_RSI_ST_SUPERTREND_MULT` | `10` / `3` | SuperTrend ATR period + multiplier — SuperTrend is the entry directional gate. |
| `EMA_RSI_ST_SL_PAUSE_CANDLES` | `3` | After an SL / option-stop hit on a side, block that side for N candles (0 = off) |
| `EMA_RSI_ST_OPPOSITE_SIDE_COOLDOWN_ENABLED` | `true` | When `true`, after any non-flip exit (SL / trail SL / option-stop / EMA touch-back) block entries on the OPPOSITE side for N candles. Prevents whipsaw flips on chop. Opposite-signal / EOD / manual exits do not trigger the cooldown. |
| `EMA_RSI_ST_OPPOSITE_SIDE_COOLDOWN_CANDLES` | `3` | Opposite-side cooldown duration in candles (× `TRADE_RESOLUTION` → minutes; e.g. 3 candles × 5-min = 15 min). |
| `EMA_RSI_ST_EOD_EXIT_TIME` | `15:15` | Square off any open position at/after this IST time, ahead of the market-close auto-stop |
| `VIX_FILTER_ENABLED` / `VIX_MAX_ENTRY` | `false` / `20` | Block entries above this VIX (EMA_RSI_ST-scoped) |
| `TRADE_ENTRY_START` | `09:30` | Earliest entry time (IST) |
| `TRADE_ENTRY_END` | `14:00` | Latest entry time (IST) |
| `TRADE_EXPIRY_DAY_ONLY` | `false` | Only trade on NIFTY expiry day |
| `EMA_RSI_ST_OPTION_EXPIRY_OVERRIDE` | (blank) | EMA_RSI_ST-only expiry override — keep EMA_RSI_ST on next-week expiry while bb_rsi/PA trade current. Blank inherits the common expiry. |
| `EMA_RSI_ST_OPTION_EXPIRY_TYPE` | (blank) | EMA_RSI_ST-only expiry type (`weekly`/`monthly`) for the override above. Blank inherits the common `OPTION_EXPIRY_TYPE`. |
| (auto) | — | EMA_RSI_ST `/start` is **blocked** when configured expiry == today (0DTE refusal — gamma risk on holding EMA_RSI_ST through expiry). |

> Common expiry knobs (`OPTION_EXPIRY_OVERRIDE`, `OPTION_EXPIRY_TYPE`) live under **Common — Instrument & Backtest** in Settings and are read by `src/config/instrument.js` for every engine that does not set its own per-mode override.

### BB_RSI Mode (3 / 5-min, Fyers)
Full spec: [BB_RSI.md](BB_RSI.md).
| Key | Default | Notes |
|-----|---------|-------|
| `BB_RSI_MODE_ENABLED` | `true` | Show/hide bb_rsi menus in sidebar (also hides BB_RSI section in Settings) |
| `BB_RSI_ENABLED` | `false` | Must be `true` for Fyers bb_rsi orders |
| `BB_RSI_RESOLUTION` | `5` | BB_RSI candle size — `3` or `5` min |
| `BB_RSI_BB_PERIOD` / `BB_RSI_BB_STDDEV` | `20` / `1` | Bollinger inputs (std-dev **1** — tighter than the charting default of 2) |
| `BB_RSI_RSI_CE_THRESHOLD` | `70` | Take CE entry only when RSI is above this |
| `BB_RSI_RSI_PE_THRESHOLD` | `40` | Take PE entry only when RSI is below this |
| `BB_RSI_RSI_TURNING` | `false` | Require RSI momentum to confirm direction (CE: RSI not falling; PE: not rising) |
| `BB_RSI_CONFIRM_CANDLE_ENABLED` | `true` | **Confirmation candle (cross & close).** `true` (default): a fully-closed candle must meet all entry rules (the *signal candle*), then the **immediately-next** candle must cross that signal candle's close (CE above / PE below) — entry fires **intra-bar** on the cross. `false`: legacy — enter at the signal candle's close. Filters one-candle false breakouts. A/B via `/replay`. |
| `BB_RSI_CONFIRM_OUTSIDE_BAND` | `true` | **Confirmation must close outside band** (needs `BB_RSI_CONFIRM_CANDLE_ENABLED=true`). `true` (default): the confirmation candle must **close** beyond the signal candle's close **and** outside the band (CE above upper / PE below lower) — entry fires at that **close**, not intra-bar. Blocks intra-bar pokes that close back inside the band (failed breakouts that otherwise leave the entry candle visibly inside the band). `false`: legacy — enter intra-bar on the first cross of the signal candle's close. A/B via `/replay`. |
| `BB_RSI_SUPERTREND_PERIOD` / `BB_RSI_SUPERTREND_MULT` | `10` / `3` | **SuperTrend(10,3)** — the sole trend source: directional entry confirmation, initial SL value **and** the candle-close trend-flip exit. |
| `BB_RSI_MAX_ENTRY_SL_PTS` | `50` | Skip entries where the SuperTrend line is more than this many pts from close (avoids uncapped risk). `0` = off |
| `BB_RSI_ADX_ENABLED` | `false` | Trend filter — block all entries when ADX(14) is below the floor (sit out chop). |
| `BB_RSI_ADX_MIN` | `20` | Minimum ADX(14) to allow entries when the trend filter is on (higher = stricter). |
| `BB_RSI_PROFIT_LOCK_TRIGGER_PTS` | `25` | Arm the profit lock once the favourable spot move (points) hits this. Points-based. `0` disables. |
| `BB_RSI_PROFIT_LOCK_PCT` | `50` | Once armed, exit when the favourable move falls below this % of peak (ratchets up) — the per-tick upside exit |
| `BB_RSI_STOP_LOSS_PTS` | `30` | Catastrophic loss cap — exit if the trade moves this many spot points against entry. Wide (only clips deep failed-fade excursions). Points-based. `0` disables. |
| `BB_RSI_BB_REENTRY_EXIT` | `true` | Exit the instant spot crosses back through the Bollinger Band (failed breakout) — per-tick, at the band line, not the bar close |
| `BB_RSI_BB_REENTRY_ARM_PTS` | `10` | Only arm the BB re-entry exit once the breakout has extended this many points past the band (avoids stopping a fresh entry on an immediate noise wick). `0` = arm immediately |
| `BB_RSI_SLIPPAGE_PTS` | `0` | Simulated slippage on entry & SL exit (pts against you) |
| `BB_RSI_MAX_DAILY_TRADES` | `30` | Daily bb_rsi cap |
| `BB_RSI_MAX_DAILY_LOSS` | `4000` | BB_RSI kill-switch in INR |
| `BB_RSI_VIX_ENABLED` | `false` | Independent VIX filter for bb_rsi |
| `BB_RSI_VIX_MAX_ENTRY` | `20` (`VIX_MAX_ENTRY` fallback) | Per-mode VIX block-entry threshold |
| `BB_RSI_VIX_STRONG_ONLY` | `16` (`VIX_STRONG_ONLY` fallback) | Per-mode strong-only threshold |
| `BB_RSI_SL_PAUSE_CANDLES` | `3` | Pause after SL hit (candles) |
| `BB_RSI_CONSEC_SL_EXTRA_PAUSE` | `2` | Extra candles pause per consecutive SL after the 2nd |
| `BB_RSI_PER_SIDE_PAUSE` | `true` | An SL on CE only pauses CE entries; PE remains free |
| `BB_RSI_ENTRY_START` / `BB_RSI_ENTRY_END` | `09:21` / `14:30` | Entry window (IST) |
| `BB_RSI_EXPIRY_DAY_ONLY` | `false` | Only allow bb_rsi entries on weekly-expiry day |

### Price Action Mode (5-min, Fyers)
| Key | Default | Notes |
|-----|---------|-------|
| `PA_MODE_ENABLED` | `true` | Show/hide PA menus in sidebar (also hides PA section in Settings) |
| `PA_ENABLED` | `false` | Must be `true` (+ `LIVE_HARNESS_DRY_RUN=false`) for Fyers PA live orders |
| `PA_RESOLUTION` | `5` | Candle size in minutes (`5` or `3`) |
| `PA_ENTRY_START` / `PA_ENTRY_END` | `09:20` / `14:30` | Entry window (IST) |
| `PA_PATTERN_DOUBLE_BOTTOM` | `true` | Toggle Double Bottom (W) → CE |
| `PA_PATTERN_DOUBLE_TOP` | `true` | Toggle Double Top (M) → PE |
| `PA_PATTERN_ASC_TRIANGLE` | `true` | Toggle Ascending Triangle → CE |
| `PA_PATTERN_DESC_TRIANGLE` | `true` | Toggle Descending Triangle → PE |
| `PA_CHART_PATTERN_TOL` | `12` | Tolerance (pts) for "equal" twin tops/bottoms and flat S/R lines (env-only) |
| `PA_MIN_BODY` | `5` | Minimum breakout-candle body (pts) (env-only) |
| `PA_SR_LOOKBACK` | `30` | Candles scanned for swing highs/lows — detection + structure trail (env-only) |
| `PA_RETEST_ENABLED` | `true` | Wait for a pullback+retest of the broken level before entering — the breakout candle itself never enters (env-only) |
| `PA_RETEST_TOL_PTS` | `10` | How close price must return to the broken level to count as a retest (env-only) |
| `PA_RETEST_MAX_WAIT` | `4` | Candles to wait for the retest before dropping the setup (env-only) |
| `PA_SL_BUFFER_PTS` | `3` | Points beyond the pattern level where the structural SL sits (env-only) |
| `PA_MIN_SL_PTS` | `8` | Floor for SL distance (env-only) |
| `PA_MAX_SL_PTS` | `25` | Hard cap on structural SL distance (env-only) |
| `PA_BREAKEVEN_TRIGGER` | `300` | Once peak PnL ≥ ₹N, lift SL to entry+buffer. `0` disables. |
| `PA_BREAKEVEN_BUFFER` | `1` | Spot pts above (CE) / below (PE) entry for the breakeven SL |
| `PA_SLIPPAGE_PTS` | `0` | Simulated slippage (backtest only) |
| `PA_MAX_DAILY_TRADES` | `30` | Daily PA cap |
| `PA_MAX_DAILY_LOSS` | `2000` | PA kill-switch in INR |
| `PA_SL_PAUSE_CANDLES` | `2` | Candles to pause a side after an SL hit |
| `PA_CONSEC_SL_EXTRA_PAUSE` | `2` | Extra candles pause per consecutive SL after the 2nd |
| `PA_VIX_ENABLED` | `false` | Independent VIX filter for PA |
| `PA_VIX_MAX_ENTRY` | `20` (`VIX_MAX_ENTRY` fallback) | Per-mode VIX block-entry threshold |
| `PA_OI_ENABLED` | `false` | Apply the OI-buildup filter to PA entries (requires the master OI switch ON) |
| `PA_EXPIRY_DAY_ONLY` | `false` | Only allow PA entries on weekly-expiry day |

### ORB Mode (Opening Range Breakout, Fyers)
| Key | Default | Notes |
|-----|---------|-------|
| `ORB_MODE_ENABLED` | `true` | Show/hide ORB menus in sidebar (and Settings section) |
| `ORB_LIVE_ENABLED` | `false` | Must be `true` AND `LIVE_HARNESS_DRY_RUN=false` for real Fyers orders |
| `ORB_LIVE_DRY_RUN` | `false` | Keep ORB in dry-run (log only) even when the global harness dry-run is off — lets other strategies go live while ORB stays simulated |
| `ORB_OI_ENABLED` | `false` | Apply the OI-buildup filter to ORB entries (needs the master OI switch on) |
| `ORB_EXPIRY_DAY_ONLY` | `false` | Only trade ORB on weekly-expiry day (Tuesday) |
| `ORB_RANGE_START` / `ORB_RANGE_END` | `09:15` / `09:30` | Opening-range window (IST) |
| `ORB_ENTRY_END` | `11:30` | Stale-breakout cutoff (no new entries past this; V3 default 11:30) |
| `ORB_FORCED_EXIT` | `15:15` | Hard EOD square-off |
| `ORB_ENTRY_V3_ENABLED` | `true` | **Trend-day engine (default, 2026-07-10).** Adaptive ATR gates + fresh-ground + confirmation + optional retest; slightly-ITM. Takes precedence over V2/V1. See ORB entry section above |
| `ORB_ITM_STEPS` | `1` | Strikes ITM (×50) for ~delta 0.6 (CE lower / PE higher). `0` = ATM. ORB only |
| `ORB_ATR_PERIOD` | `14` | V3 ATR lookback (5-min & 15-min), the volatility yardstick for all adaptive gates |
| `ORB_OR_ATR_MIN` / `ORB_OR_ATR_MAX` | `0.7` / `2.5` | V3 day filter: keep the day only if OR width is in this band × `ATR(15m)` |
| `ORB_GAP_OR_MULT` | `3` | V3 day filter: skip when `|gap| > this × OR width` (`0` = off) |
| `ORB_PRIORDAY_LEVEL_FILTER` | `true` | V3: breakout must also clear the prior day's High (CE) / Low (PE) — fresh ground. Turn off if it blocks too many days |
| `ORB_BODY_ATR_MULT` | `0.6` | V3: breakout candle body ≥ this × `ATR(5m)` |
| `ORB_BUFFER_OR_MULT` / `ORB_BUFFER_ATR_MULT` | `0.15` / `0.3` | V3 breakout buffer = `max(OR-mult×OR, ATR-mult×ATR5, 1pt)` |
| `ORB_CONFIRM_ENABLED` | `true` | Require the next candle to extend the move (HH/HC ∙ LL/LC) before entering |
| `ORB_RETEST_MODE` | `optional` | V3 retest: `optional` = non-blocking fallback (retest/resume/window-end), never vetoes a trend; `off` = confirmed-breakout only |
| `ORB_RETEST_TOL_MIN` / `ORB_RETEST_TOL_PCT` | `5` / `0.1` | Retest zone depth: price must return within `max(min, pct×range)` of the broken edge |
| `ORB_RETEST_MAX_WAIT` | `4` | V3 optional-retest window (candles after a hesitating confirmation); also the V2 backtest gate's wait |
| `ORB_MAX_SPREAD_PTS` | `2` | STEP 8: skip when option ask−bid exceeds this (falls back to `MAX_BID_ASK_SPREAD_PTS`; fails open with no depth) |
| `ORB_SIG_WINDOW` | `260` | Backtest only: trailing multi-day bar window fed to `getSignal` (seeds ATR / prior-day levels) |
| `ORB_BT_SEED_PREMIUM` | `240` | Backtest only: slightly-ITM entry-premium proxy for the δ+θ sim |
| `ORB_MIN_RANGE_PTS` / `ORB_MAX_RANGE_PTS` / `ORB_MIN_BODY` | `30` / `80` / `15` | **V2 only** — V3 uses the ATR-relative gates above |
| `ORB_BODY_PCT_MIN` / `ORB_WICK_PCT_MAX` / `ORB_RSI_*` / `ORB_TREND_EMA_*` / `ORB_ADX_*` / `ORB_MAX_GAP_PTS` / `ORB_BREAKOUT_BUFFER_*` | — | **V2 only** — the confirmed-breakout stack V3 replaces/drops |
| `ORB_CLOSE_POS_PCT` | `0.25` | Breakout candle must close within top/bottom % of its range (V2 default `0.20`, V3 `0.25`) |
| `ORB_RETEST_ENABLED` | `false` | **V2 backtest only** — ignored under V3 (which has its own optional retest) |
| `ORB_TRAIL_EMA` | `20` | Exit trend-trail: exit only when a candle closes back across this EMA of 5-min closes |
| `ORB_BREAKEVEN_PTS` / `ORB_BREAKEVEN_OR_MULT` | `20` / `0.5` | Adaptive breakeven: lift hard SL to entry once `max(fixed, mult×OR)` pts in profit (`0` mult = fixed only) |
| `ORB_OPP_CANDLE_EXIT` / `ORB_OPP_CANDLE_BODY_MULT` | `true` / `0.3` | Exit on a strong opposite candle (body ≥ mult×OR width, closing back inside the box) |
| `ORB_MAX_TRADE_LOSS` | `1500` | Per-trade unrealised-₹ loss cap (`0` = off) |
| `ORB_PREMIUM_STOP_PCT` | `35` | Exit if option premium collapses ≥ this % from entry (IV-crush/vega backstop; `0` = off) |
| `ORB_TARGET_RANGE_MULT` | `1.5` | Informational target line only (no longer an exit) |
| `ORB_WICK_FILTER_ENABLED` / `ORB_MAX_WICK_RATIO` | `true` / `0.6` | **V1 only.** Reject candles whose opposing wick exceeds ratio × body (V2 uses `ORB_WICK_PCT_MAX` instead) |
| `ORB_VWAP_FILTER_ENABLED` | `true` | CE only above VWAP, PE only below (falls back to TWAP for volumeless candles) |
| `ORB_VOL_FILTER_ENABLED` | `false` | Breakout volume ≥ multiplier × avg of prior N. **Off by default** — NIFTY spot has no real volume (paper/live see a tick count, backtest sees zero), so the gate can't agree across modes |
| `ORB_VOL_MULT` / `ORB_VOL_LOOKBACK` | `1.2` / `5` | Volume filter inputs |
| `ORB_PREMIUM_GATE_ENABLED` | `true` | Skip when ATM LTP is outside `[ORB_PREMIUM_MIN, ORB_PREMIUM_MAX]` |
| `ORB_PREMIUM_MIN` / `ORB_PREMIUM_MAX` | `120` / `400` | Acceptable option-premium band (₹, STEP 8) — widened for slightly-ITM |
| `ORB_SWEET_MIN` / `ORB_SWEET_MAX` / `ORB_STRONG_BODY` | `30` / `80` / `15` | **V1 only.** Sweet-spot tiering (STRONG vs MARGINAL) |
| `ORB_VIX_ENABLED` | `false` | Independent VIX filter |
| `ORB_VIX_MAX_ENTRY` / `ORB_VIX_STRONG_ONLY` | `22` / `18` | Per-mode VIX thresholds |
| `ORB_MAX_DAILY_TRADES` | `1` | Textbook 1/day — raise only if you accept the chop |
| `ORB_MAX_DAILY_LOSS` | `3000` | ORB kill-switch (INR) |
| `ORB_RISK_THROTTLE_ENABLED` | `true` | Portfolio breaker: sit out entries on a weekly-loss stop / losing streak (paper + live tracked separately in `~/trading-data/orb_risk_state.json`) |
| `ORB_MAX_WEEKLY_LOSS` | `9000` | Stop entries for the rest of the ISO-week once week realised P&L ≤ −this (₹; `0` = off) |
| `ORB_LOSS_STREAK_SKIP` | `4` | Sit out the next day after this many consecutive losing days (one-day cool-off; `0` = off) |

### EMA9 + VWAP Mode (EMA9 vs VWAP ±σ band, Zerodha)
| Key | Default | Notes |
|-----|---------|-------|
| `EMA9VWAP_MODE_ENABLED` | `true` | Show/hide EMA9+VWAP menus in sidebar (and Settings section) |
| `EMA9VWAP_LIVE_ENABLED` | `false` | Must be `true` AND `LIVE_HARNESS_DRY_RUN=false` for real Zerodha orders |
| `EMA9VWAP_LIVE_DRY_RUN` | `false` | Hold EMA9+VWAP in dry-run even when global harness dry-run is off |
| `EMA9VWAP_BAND_MULT` | `1` | VWAP band σ multiplier (1 = ±1σ, TradingView default; 0 = plain VWAP line) |
| `EMA9VWAP_EMA_PERIOD` | `9` | EMA length crossed against the band |
| `EMA9VWAP_STRENGTH_FILTER` | `false` | Drop WEAK band-breaks (small penetration = likely noise); only STRONG crosses trade. Graded inside `getSignal` so paper/live/backtest match. Off by default — fewer trades, validate before enabling. |
| `EMA9VWAP_STRONG_MIN_SIGMA` | `0.25` | A break is STRONG if EMA9 clears the band edge by ≥ this many σ; smaller = WEAK. Only used when `EMA9VWAP_STRENGTH_FILTER=true`. |
| `EMA9VWAP_VWAP_SESSION_START` | `09:15` | VWAP session anchor (resets daily from here) |
| `EMA9VWAP_ENTRY_START` / `EMA9VWAP_ENTRY_END` | `10:30` / `14:30` | Entry window (IST) |
| `EMA9VWAP_EOD_EXIT_TIME` | `15:15` | Hard square-off for any open position |
| `EMA9VWAP_STOP_TIME` | `15:30` | Engine auto-stop time |
| `EMA9VWAP_MAX_DAILY_TRADES` / `EMA9VWAP_MAX_DAILY_LOSS` | `20` / `5000` | Daily caps |
| `EMA9VWAP_OPT_STOP_PCT` / `EMA9VWAP_STOP_LOSS_PTS` | `0` / `0` | Optional catastrophe stops (0 = off; pure signal exit) |
| `EMA9VWAP_REVERSAL_EXIT_ENABLED` | `true` | 2-candle reversal exit — square off when a candle closes hard against the position (CE: bearish close below both prior-2 lows; PE: bullish close above both prior-2 highs), evaluated on candle close |
| `EMA9VWAP_CONFIRM_CANDLE_ENABLED` / `EMA9VWAP_INTRACANDLE_ENTRY` | `false` / `false` | Both off → entry on the cross candle's close |
| `EMA9VWAP_SL_PAUSE_CANDLES` | `3` | Same-side SL cooldown (candles) — inert unless an optional stop is enabled |
| `EMA9VWAP_OPPOSITE_SIDE_COOLDOWN_ENABLED` / `_CANDLES` | `true` / `3` | Block the flip side for N candles after a signal-cross / reversal exit |
| `EMA9VWAP_MAX_CONSEC_LOSSES` | `0` | Chop guard — sit out the session after N straight losses (0 = off) |
| `EMA9VWAP_NEG_CANDLE_LIMIT` | `0` | Square off a still-red trade after N candles (0 = off) |
| `EMA9VWAP_CANDLE_TRAIL_ENABLED` / `_BARS` | `false` / `3` | Optional N-bar structural trailing stop (tighten-only) |
| `EMA9VWAP_SL_MODE` | `ema` | `candle` re-enables the legacy time-stop; `ema` = pure signal exit |

### Trend Pullback Mode (15m bias + 5m pullback, Fyers)
Trend-continuation option-buyer: 15m trend bias (swing structure + EMA20>EMA50 + slope + session VWAP) → healthy 5m pullback into the EMA20(5m) zone → resumption candle closing beyond the prior bar with body ≥ ATR-fraction. All exits ride on **spot** except the premium disaster backstop. No fixed target, no partial booking, fixed lot size. Runs on the shared Fyers socket.
| Key | Default | Notes |
|-----|---------|-------|
| `TREND_PB_MODE_ENABLED` | `true` | Master toggle — sidebar group + Settings section |
| `TREND_PB_ENTRY_START` / `TREND_PB_ENTRY_END` | `09:45` / `14:30` | Entry window (IST) |
| `TREND_PB_SWING_LOOKBACK` | `2` | N-bar pivot for swing-structure (HH/HL) detection |
| `TREND_PB_BODY_ATR_MULT` | `0.5` | Resumption candle body must be ≥ this × ATR5 (the volume-replacement conviction gate) |
| `TREND_PB_PULLBACK_MAX_ATR` | `1.5` | Max pullback depth vs ATR5 (rejects deep/broken pullbacks) |
| `TREND_PB_TRAIL_ATR_MULT` | `2.5` | ATR-chandelier trail multiplier (best-spot − mult×ATR5) |
| `TREND_PB_BREAKEVEN_R` | `1.0` | R multiple at which the stop lifts to entry |
| `TREND_PB_STOP_CLAMP_MIN` / `TREND_PB_STOP_CLAMP_MAX` | `8` / `30` | Structural-stop clamp (spot pts) |
| `TREND_PB_TIME_STOP_CANDLES` | `6` | Exit a still-flat trade after N candles (theta) |
| `TREND_PB_FORCED_EXIT` | `15:15` | EOD square-off (IST) |
| `TREND_PB_PREMIUM_STOP_PCT` | `35` | Premium disaster backstop — hard exit when option LTP ≤ −N% of entry |
| `TREND_PB_ITM_STEPS` | `1` | Strikes shifted in-the-money (~delta 0.6) |
| `TREND_PB_MAX_DAILY_LOSS` | `5000` | Daily loss kill-switch (₹) |
| `TREND_PB_MAX_DAILY_TRADES` | `3` | Max entries per session (selective by design) |
| `TREND_PB_LOSS_STREAK_SKIP` | `3` | Pause entries after N consecutive losers (0 = off) |
| `TREND_PB_VIX_ENABLED` / `TREND_PB_VIX_MAX_ENTRY` | `false` / `22` | Per-mode VIX gate (falls back to global `VIX_MAX_ENTRY`) |
| `TREND_PB_LIVE_ENABLED` | `false` | Master switch for live orders (Phase C) — see Live Harness table |
| `TREND_PB_BT_SLIPPAGE_PTS` | `1.5` | Backtest spread/slippage haircut, each way (premium pts) |
| `TREND_PB_BT_SEED_PREMIUM` | `240` | Assumed slightly-ITM entry premium for the backtest δ+θ sim |

### Paper Investment Pools (per broker)
Paper capital is pooled per broker, not per strategy. Each strategy's running capital = its broker pool + that strategy's all-time paper P&L. The Real-Time Monitor (dashboard) shows each pool's remaining balance.
| Key | Default | Notes |
|-----|---------|-------|
| `ZERODHA_INV_AMOUNT` | `100000` | Paper investment pool for Zerodha strategies (EMA_RSI_ST) |
| `FYERS_INV_AMOUNT` | `100000` | Paper investment pool for Fyers strategies (BB_RSI + PA + ORB + Trend Pullback) |

### VIX Filter (per-module)
| Key | Default | Notes |
|-----|---------|-------|
| `VIX_FILTER_ENABLED` | `true` | Block EMA_RSI_ST entries in high-VIX |
| `VIX_MAX_ENTRY` | `20` | EMA_RSI_ST block-all-entries threshold |
| `VIX_STRONG_ONLY` | `16` | EMA_RSI_ST strong-only threshold |
| `VIX_FAIL_MODE` | `closed` | When VIX unavailable: closed = block (safe), open = allow |
| `BB_RSI_VIX_ENABLED` | `false` | Independent toggle |
| `BB_RSI_VIX_MAX_ENTRY` | inherits | Per-mode threshold (falls back to `VIX_MAX_ENTRY` if unset) |
| `BB_RSI_VIX_STRONG_ONLY` | inherits | Per-mode threshold (falls back to `VIX_STRONG_ONLY`) |
| `PA_VIX_ENABLED` | `false` | Independent toggle |
| `PA_VIX_MAX_ENTRY` | inherits | Per-mode threshold |

### OI + Price Buildup Filter (per-module)
Blocks directional entries that fight the prevailing Open-Interest buildup: reads NIFTY current-expiry **futures OI** vs spot over a short lookback (Settings → *Open-Interest Filter*), classifies the regime, and blocks **CE in a SHORT_BUILDUP** and **PE in a LONG_BUILDUP**. Weak (short-covering / long-unwinding), neutral, warmup, and OI-missing all **fail open** (allow). **Live/paper only — never evaluated in backtest/replay** (OI is not recorded in tick files). Each entered trade records `oiAtEntry` + `oiRegime` and appends the regime to `entryReason`; blocks are logged to the skip log under `gate:"oi"`.

| Key | Default | Notes |
|-----|---------|-------|
| `OI_FILTER_ENABLED` | `false` | **Master switch** — OFF disables the filter for every strategy regardless of the per-mode toggles |
| `EMA_RSI_ST_OI_ENABLED` | `false` | Apply to EMA_RSI_ST (requires master ON) |
| `BB_RSI_OI_ENABLED` | `false` | Apply to BB_RSI (requires master ON) |
| `PA_OI_ENABLED` | `false` | Apply to PA (requires master ON) |
| `ORB_OI_ENABLED` | `false` | Apply to ORB (requires master ON) |
| `TREND_PB_OI_ENABLED` | `false` | Apply to Trend Pullback (requires master ON) |
| `OI_LOOKBACK_CANDLES` | `3` | Candles back to measure ΔOI / Δspot (≈15 min at 5-min) |
| `OI_MIN_DELTA_PCT` | `1` | Noise floor — |ΔOI| below this % over the lookback = NEUTRAL (allow) |
| `OI_FAIL_MODE` | `open` | When futures OI can't be fetched: open = allow (default), closed = block |

### Trade Guards (shared across modes)
| Key | Default | Notes |
|-----|---------|-------|
| `MAX_BID_ASK_SPREAD_PTS` | `2` | Block entry when option bid-ask spread > N pts (fails open if quotes missing) |
| `TIME_STOP_CANDLES` | `4` | Auto-exit a trade flat for N candles |
| `TIME_STOP_FLAT_PTS` | `20` | "Flat" defined as |PnL| < N points |
| `GAP_THRESHOLD_PTS` | `50` | Live engines skip the first candle when overnight gap exceeds this |
| `LTP_STALE_THRESHOLD_SEC` | `15` | Warn in logs when option LTP has no update for this many seconds |
| `LTP_STALE_FALLBACK_SEC` | `5` | Live engines fall back to candle close when option LTP is older than this |
| `HARD_SL_ENABLED` | `false` | Place an SL-M order at the exchange on every entry (options only) — protects against bot crash/disconnect |
| `HARD_SL_DELTA` | `0.5` | Delta used when converting spot SL → option premium trigger |

### Tick Recorder / Replay / Live Harness
| Key | Default | Notes |
|-----|---------|-------|
| `TICK_RECORDER_ENABLED` | `true` | Record spot/option/VIX/OI ticks to `~/trading-data/ticks/YYYY-MM-DD/*.jsonl` during every paper/live session. Required for Replay. Pure observer — zero impact on trading. |
| `TICK_RECORDER_RETAIN_DAYS` | `30` | Auto-delete tick recordings older than this many days (~10 MB/day across streams) |
| `SETTINGS_AUDIT_RETAIN_DAYS` | `3` | Keep only this many days of `settings-audit.jsonl` (the Trade Logs → Checkpoints & Settings Changes tab); older entries are pruned on every save and never shown |
| `BACKUP_ENABLED` | `true` | Cut a daily self-contained `.tar.gz` snapshot of `~/trading-data` + `data/ticks` (caches & OAuth tokens excluded) into `~/trading-data/_backups/`. Download it from Settings → Backup & Restore; a banner nags on every page until the day's copy is downloaded. Pure observer — zero impact on trading. |
| `BACKUP_HOUR_IST` | `16` | Hour of day (IST) the daily snapshot is cut (after market close). Timer armed at boot — restart to re-arm a changed hour. |
| `BACKUP_RETAIN_DAYS` | `14` | Daily snapshots keep only the latest (a new one deletes the old). This prunes the hidden pre-restore safety snapshots older than this many days. |
| `BACKUP_TG_ENABLED` | `false` | Send a Telegram message when each day's snapshot is ready (or if it fails). |
| `LIVE_HARNESS_DRY_RUN` | `true` | **Global** kill-switch. When ON, all live order paths (PA/ORB harness routes **and EMA_RSI_ST Live**) log the broker call that *would* have been made but place no real order. When OFF, each strategy goes real **unless** its own `{STRATEGY}_LIVE_DRY_RUN` override is on. Switch OFF only after verifying decisions match paper. |
| `EMA_RSI_ST_LIVE_DRY_RUN` | `false` | Per-strategy override — keeps EMA_RSI_ST in dry-run even when `LIVE_HARNESS_DRY_RUN=false`. Lets you take other strategies live while EMA_RSI_ST stays simulated (and vice-versa). |
| `ORB_LIVE_DRY_RUN` | `false` | Per-strategy override — keeps ORB in dry-run even when the global flag is off. |
| `PA_LIVE_DRY_RUN` | `false` | Per-strategy override — keeps the PA live harness in dry-run even when the global flag is off. |
| `BB_RSI_LIVE_DRY_RUN` | `false` | Per-strategy override — keeps BB_RSI in dry-run even when the global flag is off. BB_RSI Live has no master-enable gate, so this (with the global flag) is its primary safety switch. |
| `TREND_PB_LIVE_DRY_RUN` | `false` | Per-strategy override — keeps the Trend Pullback live harness in dry-run even when the global flag is off. |
| `BACKTEST_OPTION_SIM` | `true` | Legacy bar-based backtest only — Replay uses recorded option ticks |
| `BACKTEST_DELTA` / `BACKTEST_THETA_DAY` / `BACKTEST_SLIPPAGE_PTS` | `0.5` / `12` / `0` | Bar-based backtest inputs |

### UI Visibility Toggles
| Key | Default | Notes |
|-----|---------|-------|
| `UI_THEME` | `dark` | `dark` or `light` |
| `UI_SHOW_DASHBOARD` | `false` | When off, `/` redirects to Settings |
| `UI_SHOW_ALL_BACKTEST` | `true` | Top-level "Backtest" (unified) menu |
| `UI_SHOW_REALTIME` | `true` | Dashboard auto-swaps to Real-Time monitor while any session is running |
| `UI_DASHBOARD_ANALYTICS_PANEL` | `true` | Bottom analytics panel (live P&L during market hours; rolling stats after hours) |
| `UI_SHOW_REPLAY` | `true` | Top-level "Replay" menu (tick replay of recorded paper sessions) |
| `UI_SHOW_PAPER_HISTORY` / `UI_SHOW_LIVE_HISTORY` | `true` | Cross-mode history menus |
| `UI_SHOW_EDGE_ANALYTICS` | `true` | Top-level "Edge Analytics" menu (`/edge-analytics`) |
| `UI_SHOW_CONSOLIDATION_REPORT` | `true` | "📑 Consolidation Report" button on the Edge Analytics page → the daily consolidated report (`/consolidation-report`) |
| `{EMA_RSI_ST,BB_RSI,PA,ORB,EMA9VWAP,TREND_PB}_MODE_ENABLED` | `true` | Master toggle — hides sidebar group AND Settings section for that strategy |
| `UI_SHOW_SIMULATE` | `false` | Show "Simulate" link under each mode in sidebar |
| `UI_SHOW_COMPARE` | `false` | Show "Compare" link |
| `UI_SHOW_TRACKER` | `false` | Show "Tracker" under EMA_RSI_ST |
| `UI_SHOW_{EMA_RSI_ST,BB_RSI,PA,ORB,EMA9VWAP,TREND_PB}_{BACKTEST,PAPER,LIVE,HISTORY}` | `true` | Per-submenu toggles for each strategy group |
| `UI_SHOW_PA_LIVE_HARNESS` | `false` | Show "Live (Harness)" inside the PA group |
| `UI_SHOW_{EMA_RSI_ST,BB_RSI,ORB}_LIVE_HARNESS` | `false` | Show "Live (Harness)" inside the EMA_RSI_ST/BB_RSI/ORB group — runs LIVE by wrapping PAPER (LIVE = PAPER) |
| `UI_SHOW_PA_PATTERN_BACKTEST` | `true` | Show "Pattern Test" inside the PA group |
| `UI_SHOW_TRADE_LOGS` | `true` | Show **Logs** in the System sidebar group |
| `UI_SHOW_LOGS` / `UI_SHOW_CACHE_FILES` | `true` | Show the **Server Logs** / **Cache Files** tabs on the Logs (`/trade-logs`) page |

> Per-menu / per-submenu visibility toggles are also configurable via the Settings UI — hide entire mode sections (EMA_RSI_ST / BB_RSI / PA / ORB) from the sidebar without disabling the underlying engine, or hide individual links (e.g., hide Backtest but keep Paper + Live) within a still-visible mode section. Driven by env vars + Settings UI; persists across restart.

### Security & Safety
| Key | Default | Notes |
|-----|---------|-------|
| `API_SECRET` | — | Protects action routes (start/stop/exit) & settings. Leave blank to disable. |
| `LOGIN_SECRET` | — | Page-level password gate. Leave blank for open access. |
| `LOGIN_SESSION_MIN` | `15` | Idle minutes before the login cookie expires (each request slides the timer). |
| `LOGIN_RATE_MAX` / `LOGIN_RATE_WINDOW_MIN` | `5` / `15` | Failed-attempt rate-limit per IP |
| `WRITE_RATE_PER_MIN` / `WRITE_RATE_BURST` | `120` / `30` | Per-IP cap on POST/PUT/DELETE/PATCH (`0` disables) |
| `BROKER_CB_FAIL_THRESHOLD` / `BROKER_CB_OPEN_SEC` | `5` / `30` | Broker circuit breaker — opens after N consecutive failures, half-open probe after T sec |
| `BROKER_RETRY_WRITE_ATTEMPTS` / `BROKER_RETRY_READ_ATTEMPTS` / `BROKER_RETRY_BASE_MS` | `2` / `3` / `150` | Order / query retry — writes use linear backoff and only retry pre-flight errors (never double-place) |

### Telegram Alerts (master gate + per-mode toggles)
| Key | Default | Notes |
|-----|---------|-------|
| `TELEGRAM_BOT_TOKEN` | — | From @BotFather |
| `TELEGRAM_CHAT_ID` | — | Your chat ID — leave blank to disable notifications |
| `TG_ENABLED` | `true` | **Master gate** — when off, no alerts send regardless of below |
| `TG_{EMA_RSI_ST,BB_RSI,PA,ORB,EMA9VWAP,TREND_PB}_STARTED` | `true` | Session-start alerts per mode |
| `TG_{EMA_RSI_ST,BB_RSI,PA,ORB,EMA9VWAP,TREND_PB}_ENTRY` | `true` | Trade-entry alerts per mode |
| `TG_{EMA_RSI_ST,BB_RSI,PA,ORB,EMA9VWAP,TREND_PB}_EXIT` | `true` | Trade-exit alerts per mode |
| `TG_{EMA_RSI_ST,BB_RSI,PA,EMA9VWAP}_SIGNALS` | `true/false/false/false` | Candle-close skip/signal reasoning (these modes only — ORB and Trend Pullback emit no signal alerts) |
| `TG_{EMA_RSI_ST,BB_RSI,PA,ORB,EMA9VWAP,TREND_PB}_DAYREPORT` | `true` | Per-mode day-report on session stop |
| `TG_DAYREPORT_CONSOLIDATED` | `true` | One combined day report at 15:30 IST across all six modes |

> All alerts and the consolidated report also respect the strategy master toggles (`{EMA_RSI_ST,BB_RSI,PA,ORB,EMA9VWAP,TREND_PB}_MODE_ENABLED`): a disabled strategy sends no alerts and is omitted from the consolidated report, regardless of its `TG_*` toggles.

### Charges (April 2026 rates)
| Key | Default | Notes |
|-----|---------|-------|
| `STT_OPT_SELL_PCT` | `0.15` | STT on options sell-side (%) |
| `STT_FUT_SELL_PCT` | `0.05` | STT on futures sell-side (%) |
| `EXCHANGE_TXN_OPT_PCT` | `0.03553` | NSE options exchange txn — % of premium turnover |
| `EXCHANGE_TXN_FUT_PCT` | `0.00183` | NSE futures exchange txn — % of turnover |
| `SEBI_CHARGES_PER_CRORE` | `10` | SEBI turnover fee (₹/Cr) |
| `STAMP_DUTY_PCT` | `0.003` | Stamp duty on buy-side turnover (%) |
| `GST_PCT` | `18` | GST on brokerage + exchange txn + SEBI |
| `BROKER_FLAT_PER_ORDER` | `20` | Flat brokerage per order (×2 for buy+sell) |

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
| `/bb_rsi-backtest` | BB_RSI backtest (3/5-min BB+SuperTrend+RSI V7) |
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

### Analytics & Tools
| URL | Description |
|-----|-------------|
| `/realtime` | **Unified real-time monitor** — one screen for all enabled strategies with a PAPER/LIVE toggle. Cards for EMA_RSI_ST / BB_RSI / PA / ORB (each card is hidden when its `{STRATEGY}_MODE_ENABLED` is off) showing open position + today's stats, with a rollup table for **Today Total (Open + Closed)**. Read-only; polls each strategy's `/status/data` every 4s. Theme-aware. **Per-card Open Status + Copy Day Log buttons** (Copy Day Log copies raw entry + skip JSONL, not the human-readable summary). |
| `/replay` | **Tick Replay** — deterministic re-run of a recorded paper session through the paper `onTick()` handlers. Single-date and date-range modes. Snapshot mode (session-start settings) vs current-settings mode (live `process.env`). Per-row diagnostic Replay buttons + downloadable diagnostic dump. Outputs land in `~/trading-data/_replay_trades/` (snapshot) or `_replay_trades_sim/` (current). |
| `/all-backtest` | **Unified backtest dashboard** — runs the same date range across all enabled strategies and renders the per-strategy stats side by side. |
| `/consolidation` | Cross-mode **paper** trade history + analytics (EMA_RSI_ST + BB_RSI + PA, daily/monthly/yearly roll-ups, Day View panel, per-mode breakdown) |
| `/live-consolidation` | Cross-mode **live** trade history + analytics (parity with `/consolidation` for live data) |
| `/consolidation-report` | **Consolidation Report** — a **day-by-day** consolidated report (one table row per trading day), mirroring the Telegram "CONSOLIDATED DAY REPORT" layout: per-strategy trades + P&L columns, then Total / Wins / Losses / Win rate / Net P&L + a 🟢/🔴 result per day, with a totals footer. Book toggle (Paper / Live / **Both**) + a Range preset (**This week / Last week / This month / Last month / Last 7·30 days / This FY / All time / Custom**). Reached via the **📑 Consolidation Report** button on the Edge Analytics page (not a separate sidebar item). **🖨 Save as PDF** prints through a dedicated `@media print` stylesheet (app chrome hidden, white A4-landscape page, page-break-safe table) — the browser's native print-to-PDF; no external library. Reads the same session files as `/consolidation` + `/live-consolidation`; writes nothing. Gated by `UI_SHOW_CONSOLIDATION_REPORT`. |
| `/edge-analytics` | **Edge Analytics** — read-only edge dashboard over your recorded trades. Paper/Live book toggle + per-strategy + date-range (7D / 30D / FY / custom) filters that recompute instantly client-side. Headline cards (trades, win rate, net P&L, expectancy, profit factor, avg win/loss + payoff, max drawdown, win/loss streaks), an equity curve, P&L-by-hour-of-day and P&L-by-weekday bar charts, and **By Strategy** + **By Exit Reason** breakdown tables (worst reason first, to surface the bleed). Reads the same session files as `/consolidation` + `/live-consolidation`; writes nothing. Gated by `UI_SHOW_EDGE_ANALYTICS`. |
| `/pnl-history` | Broker-wise realised P&L (one-time past baselines per broker + auto-computed live-bot P&L by FY) |
| `/compare/trading` | Paper vs Backtest comparison (EMA_RSI_ST) |
| `/compare/bb_rsi` | Paper vs Backtest comparison (bb_rsi) |
| `/settings` | All config settings UI + Bulk Edit modal (paste/delete keys) + **checkpoint note prompt on every save** + server restart. Saved notes are appended to that day's trade JSONL alongside a settings snapshot, so the daily log carries the exact config that produced its trades. Hosts the `POST /settings/reset-data` endpoint used by the **Reset Data** dialog on the Logs page. |
| `/trade-logs` | **Renamed from JSONL viewer in v4.5.0.** Per-mode trade-log file manager: per-day trade entries + cumulative skip logs in a separate tab. Top bar has a **🧹 Reset Data** button: a category picker (Paper trade history / Skip trade history / Cache / Logs / Ticks data) with a **select-all** and an optional **date range** — the range deletes matching per-day files (paper/skip daily JSONL + tick day-folders); Cache & Logs always clear fully. Checking **Paper** with **no** date range also fans out to the per-strategy `/reset` routes to restore starting capital + wipe sessions for all 5 strategies (a running strategy is skipped). Posts to `POST /settings/reset-data`. Per-mode **Download All** + **Delete All** buttons, plus a single **Download Everything (all strategies)** button on both the Trade Files and Skip Logs tabs (`/trade-logs/download-everything` and `/trade-logs/skips/download-everything`) that concatenates every mode's daily files into one self-describing JSONL (each line carries its own `mode`). JSONL is the canonical export format (CSV/PDF dropped — they were drifting on edge cases). The **Checkpoints & Settings Changes** tab now has a per-row **↩ Restore** button that reverts a key to its prior value (with a "restore all keys with the same note" checkbox when the entry has a note, and a one-click restart prompt when needed). Light-theme aware. |
| `/cache-files` | Cache / generated-file browser. Groups every on-disk cache by purpose — **Backtest Cache**, **Candle Cache**, **Recorded Ticks**, **Replay Trades** (snapshot + sim), and **Root Data Files** — each with per-file **View** / **Download** / **Delete** plus group **Download All** (`.tar.gz`) + **Delete All**. Read endpoints are open; deletes require `API_SECRET`. Path-traversal-guarded. The canonical trade/skip JSONLs keep their own page (`/trade-logs`); deleting a cache here is safe (regenerated on demand). Gated by `UI_SHOW_CACHE_FILES`. Light-theme aware. |
| `/monitor` | EC2 health metrics (CPU, RAM, disk, load average) + maintenance actions |
| `/logs` | Application logs (with SSE live feed; near-miss audit lines visible here). **Copy Log button** in the activity-log header on paLive / paPaper / emaRsiStLive / emaRsiStPaper. Also shown as the **Server Logs** tab on the Logs (`/trade-logs`) page. |
| `/docs` | README, CHANGELOG, documents viewer |
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
| `/api/holidays` | NSE holiday list |
| `/api/holidays/refresh` | Refresh NSE holiday cache |
| `/api/expiry-dates` | NIFTY weekly/monthly expiry calendar |
| `/api/cache-info` | Candle cache stats |
| `/auth/status/all` | Combined broker auth status |
| `/sync/info` | Size preview of `~/trading-data/` (used by Sync to Local button) |
| `/sync/download-all` | Streams `~/trading-data/` as a `tar.gz` (server → client) |
| `/backup/status` | Today's snapshot state `{enabled, date, exists, downloaded}` — drives the download-nag banner |
| `/backup/data` | List of on-server snapshots + schedule/retention (Settings card) |
| `/backup/download?date=YYYY-MM-DD` | Streams `backup-<date>.tar.gz` and marks it downloaded |
| `POST /backup/create` | Cut a snapshot for today now |
| `POST /backup/restore` | Upload a `backup-*.tar.gz` (raw body) and restore it over `~/trading-data` + `data/ticks`. Takes a pre-restore safety snapshot first; validates entries against path-traversal; refused while a session is active. Restart after. |
| `POST /{ema_rsi_st|bb_rsi|pa}-paper/history/restore` | Rebuild a deleted session for an IST date by replaying the daily JSONL trade log (idempotent; refuses while paper running) |

## Project Structure

```
src/
  app.js                              # Express server, dashboard, route registration, Start-All
  strategies/
    strategy1_sar_ema_rsi.js          # EMA_RSI_ST strategy (EMA 20/50 (+9 opt) + RSI + SuperTrend) — 5-min default; 15-min via TRADE_RESOLUTION=15
    bb_rsi.js                   # BB_RSI 3/5-min V7 (BB break + SuperTrend side + RSI)
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
    docs.js                           # README/CHANGELOG/docs viewer
    auth.js                           # Fyers + Zerodha OAuth
    deploy.js                         # GitHub Actions webhook + status
    loginLogs.js                      # Failed login attempt viewer
    result.js                         # Saved backtest result viewer
  utils/
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
- **Indicators**: `technicalindicators` (EMA, RSI, ADX, Parabolic SAR, Bollinger Bands)
- **Brokers**: Zerodha Kite Connect (EMA_RSI_ST live) + Fyers API v3 (bb_rsi + PA live + all data)
- **Notifications**: Telegram Bot API with 17 per-mode toggles + master gate + consolidated EOD
- **Charts**: Chart.js (theme-aware) + live candlestick overlays on status pages
- **Deployment**: PM2 on AWS EC2 t3.micro + GitHub Actions CI/CD
- **Caching**: Disk-based candle cache (backtest + live, auto-pruned)
- **Compression**: gzip middleware on all HTTP responses (≈80% size reduction on `/settings`; ~329 KB → 61 KB)

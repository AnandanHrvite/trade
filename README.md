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
| **GAPS Paper** | Extreme daily RSI + next-day gap the other way (single-leg slightly-ITM CE/PE) | Daily signal, 5-min exits | Simulated | `/gaps-paper` |
| **GAPS Backtest** | Same engine over a date range (daily signal + intraday exit sim) | Daily + 5-min historical | Historical | `/gaps-backtest` |
| **GAPS Live (Harness)** | Runs Live by wrapping Paper (Fyers orders, triple-gated dry-run) | Daily signal, 5-min exits | Fyers (PAPER-wrapped) | `/gaps-live` |
| **Trend Day Scalp Paper** | 10:15 day gate locks the side, then a VWAP/EMA20 pullback-reclaim (single-leg slightly-ITM CE/PE) | 5-min | Simulated | `/trend-day-scalp-paper` |
| **Trend Day Scalp Backtest** | Same engine over a date range (conservative intra-bar ordering) | 5-min historical | Historical | `/trend-day-scalp-backtest` |
| **Trend Day Scalp Live (Harness)** | Runs Live by wrapping Paper (Fyers orders, triple-gated dry-run) | 5-min | Fyers (PAPER-wrapped) | `/trend-day-scalp-live` |
| **3M Gap Fix Scalp Paper** | Fades a 3-min NIFTY **FUTURES** gap back to its fill level unless the next candle breaks the day high/low on volume | 3-min (futures) | Simulated | `/gap-fix-3m-paper` |
| **3M Gap Fix Scalp Backtest** | Same engine over a date range, front-month contract rolled like the live path | 3-min historical (futures) | Historical | `/gap-fix-3m-backtest` |
| **3M Gap Fix Scalp Live (Harness)** | Runs Live by wrapping Paper (Fyers orders, triple-gated dry-run) | 3-min (futures) | Fyers (PAPER-wrapped) | `/gap-fix-3m-live` |
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
- **Trailing**: each candle close, tighten SL to **EMA21** — tighten-only; an EMA21 touch-back is an explicit exit.
- **Exits**: EMA21 trail / EMA touch-back, optional N-bar candle trail (`EMA_RSI_ST_CANDLE_TRAIL_ENABLED`, tighter-of) · **negative-candle stop** (`EMA_RSI_ST_NEG_CANDLE_LIMIT`, default 2 — square off a trade still in the red after N candles) · per-trade points stop (`EMA_RSI_ST_STOP_LOSS_PTS`, off by default) · option-premium stop (`OPT_STOP_PCT`) · opposite signal · exit-before-close (`EMA_RSI_ST_EOD_EXIT_TIME`) · EOD auto-stop (`TRADE_STOP_TIME`). Choppy-day guard: halt entries after `EMA_RSI_ST_MAX_CONSEC_LOSSES` consecutive losers (off by default).
- **Same-side cooldown**: after an SL / option-stop hit, block that side for `EMA_RSI_ST_SL_PAUSE_CANDLES` candles.
- **Opposite-side (flip) cooldown**: after any non-flip exit, block the OPPOSITE side for `EMA_RSI_ST_OPPOSITE_SIDE_COOLDOWN_CANDLES` candles (toggle: `EMA_RSI_ST_OPPOSITE_SIDE_COOLDOWN_ENABLED`). Prevents whipsaw flips on chop. Opposite-signal / EOD / manual exits do not trigger it.
- **Guards kept**: VIX gate, `MAX_DAILY_LOSS`, `MAX_DAILY_TRADES`, trading window, OI buildup gate (live), bid-ask spread guard (live), expiry-day-only, EMA_RSI_ST expiry override/type.
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
- **Per-trade context logging** (additive): each trade record captures BB / RSI / trend context at entry and **MFE / MAE** (max-favorable + max-adverse excursion in pts and ₹) over the life of the trade, **`secsToMFE` / `secsToMAE`** (seconds from entry to that peak / trough — distinguishes early-peak-then-giveback from slow-grind, for trail tuning), plus **`vixAtExit`** — feeds the active paper-trade data-collection schema. This enrichment is now uniform across all 4 strategies (paper + live): each logs the signal diagnostics it computes at entry (EMA_RSI_ST: EMA20/50/21 + RSI + SuperTrend; BB_RSI: BB bands / RSI / SuperTrend; PA: pattern/trend/SR; ORB: OR width, VWAP side, body-vs-ATR, gate funnel) so post-window analysis can correlate behaviour with market conditions. Timing fields use each engine's replay-safe tick clock so replayed sessions reproduce identical values

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
  8. **One trade/day** (`ORB_MAX_DAILY_TRADES=1`), window `ORB_RANGE_END=09:30` → `ORB_ENTRY_END=11:30`.
  - Entry is always a **candle close**, never intrabar. ATR(5m)/ATR(15m) are anchored at the 09:30 OR freeze so the committed breakout candle can never be re-judged by later data; they are seeded from a multi-day preload while the OR and VWAP stay day-scoped. (Defensively, the yardstick degrades to **prior days only** rather than to the whole array if the freeze point is ever missing — a branch that is unreachable today, since a valid OR guarantees the freeze index exists.)
  - **⚠️ ATR excluded the overnight gap as of 2026-08-04 (bug fix).** Wilder true range uses the previous bar's close, so the first bar of a session scored `TR` = the close-to-open gap — a move nobody could trade — and that fed the body gate, the buffer, the ATR stop and the OR/ATR15 day filter. Provable case: 2026-07-29 reported `0.6×ATR5 = 34.8pt`, i.e. **ATR(5m) = 58pt, on a day whose entire 15-min opening range was 51.6pt**. All ATR-scaled thresholds now read lower and no longer spike after a gap, so **ORB takes more trades than before** — that is the gate finally running at its intended strictness. Consequence: every ablation number quoted in this section was measured against a distorted ruler and needs re-deriving with `scripts/orbValidate.js`.
- **Exits** (priority order, first to fire wins):
  - **Initial hard SL = the wider of the entry candle's own extreme and `ORB_SL_ATR_MULT=1.5 × ATR(5m)`.** The strategy returns this as `sig.slSpot` and paper/live/backtest all consume it — **one owner**, so the three modes cannot drift. Previously each route recomputed the stop as the entry candle's extreme alone: that averaged **23pt wide and was hit on 4 of 6 trades**, including the session that then ran 213pt our way. Rupee risk is unchanged, because `ORB_MAX_TRADE_LOSS` / `ORB_PREMIUM_STOP_PCT` bind first.
  - **Adaptive breakeven** (`ORB_BREAKEVEN_PTS=20`, `ORB_BREAKEVEN_OR_MULT=0.5`): SL lifts to entry once `max(20, 0.5×OR)` pts in profit. Measured as the single most valuable exit component — removing it cost 106pt and introduced a −77pt worst case.
  - **EMA trend-trail** (`ORB_TRAIL_EMA=20`): exit only when a candle **closes back across** the EMA. Beat EMA9 (183pt) and was chosen over a chandelier trail whose results were non-monotonic in the multiplier (i.e. noise).
  - **Strong opposite candle** (`ORB_OPP_CANDLE_EXIT`, `ORB_OPP_CANDLE_BODY_MULT=0.3`), **per-trade caps** (`ORB_MAX_TRADE_LOSS=1500`, `ORB_PREMIUM_STOP_PCT=35`), **EOD** `ORB_FORCED_EXIT=15:15`.
  - **All of the above live in ONE module — [src/strategies/orbExits.js](src/strategies/orbExits.js).** Paper, live, the backtest route and `scripts/orbValidate.js` all call it; routes keep only *execution* (simulate a fill / place a broker order / back-solve a bar fill). They used to be four hand-written copies, which is how the backtest once evaluated the close-based rules before the intrabar ones and silently reported trades the live engine could not have taken. Replay was never affected — it re-runs paper's own `onTick()`. A regression test now fails the build if any route reads an exit key directly again.
- **Risk caps**: `ORB_MAX_DAILY_LOSS=3000` (checked only when flat), **portfolio breaker** (`ORB_RISK_THROTTLE_ENABLED`, persisted at `~/trading-data/orb_risk_state.json`, paper/live tracked separately): sit out after `ORB_MAX_WEEKLY_LOSS=9000` or `ORB_LOSS_STREAK_SKIP=4` consecutive losing days. **VIX gate** (`ORB_VIX_ENABLED`), **OI gate** (`ORB_OI_ENABLED`), **expiry-day-only** (`ORB_EXPIRY_DAY_ONLY`) all still apply.
- **Debugging**: `ORB_DEBUG_TRACE=true` prints the **whole entry funnel** to the logs on every 5-min candle close — time window, OR, day sanity, breakout, body, VWAP, confirmation, retest — each PASS/FAIL/SKIP with its numbers and the final decision. The same trace always rides back on the signal as `sig.gates` (on **every** return path, warm-up included), and the skip log stores it compactly as a `funnel` field — e.g. `time window:P,trade budget:P,OR ready:P,OR vs ATR15:P,gap sanity:P,breakout:F` (~77 bytes) — so a no-trade day can be diagnosed from the log alone rather than only from its first blocking reason. Verbose; turn it off again after diagnosing.
- **Tests**: `npm test` runs the EMA9+VWAP suite **and** [tests/orb.regression.js](tests/orb.regression.js) (37 assertions). The ORB suite guards capital-safety invariants (the rupee clamp can never be exceeded, across every qty × stop-width × side), engine invariants (no repaint, **no look-ahead**, close-only entry, correct stop side), that the six deleted config keys provably no longer change behaviour, that **no engine keeps a private copy of an exit rule**, that the shared exit engine really fires the opposite-candle exit and arms breakeven off the *close* (not the intrabar extreme), and that paper/live/backtest stay in parity on the stop, on crash-recovery persistence and on the duplicate-entry guard. `npm run test:orb` runs it alone.
- **The two stops are now reconciled.** `sig.slSpot` (the ATR stop) is 50–83 spot pts on typical volatility, but `ORB_MAX_TRADE_LOSS=1500` on a 65-lot ~0.6-delta option trips after only **~38 spot pts**. [orbStopRisk.js](src/utils/orbStopRisk.js) clamps the placed stop to whatever the rupee budget allows, so **what the dashboard shows is what executes** — previously the advertised SL was ~2× wider than the level that really ended the trade. It logs whenever it clamps. Raise `ORB_MAX_TRADE_LOSS` if you want the full ATR stop; that is a capital decision, so the default is the conservative direction. Consequence: `ORB_SL_ATR_MULT` is currently **inert** — every value from 1.0 to 2.5 gives an identical result. To change real risk, change `ORB_MAX_TRADE_LOSS`.
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

### EMA_RSI_ST Strategy (EMA 20/50 (+9 opt) + RSI + SuperTrend, Zerodha)
**Entry redefined 2026-05-31; PSAR stripped 2026-06-12; close-beyond-EMA gate added 2026-06-24.** Entry (intra-candle, all 4 true): **CE** = EMA alignment bullish (2-EMA default: EMA20 above EMA50; or triple-stack `EMA_RSI_ST_EMA_TRIPLE_STACK_ENABLED`: EMA9 > EMA20 > EMA50 via `EMA_RSI_ST_EMA_FASTEST`/`EMA_RSI_ST_EMA_FAST`/`EMA_RSI_ST_EMA_SLOW`), RSI(14) `> RSI_CE_MIN` and `< RSI_CE_MAX`, **SuperTrend bullish**, **signal candle close above the base EMA** (`EMA_RSI_ST_CLOSE_BEYOND_EMA_ENABLED`, default on — base = EMA-fastest/9 when triple-stack on, else EMA-fast/20). **PE** = mirror (EMA20 below EMA50 / EMA9 < EMA20 < EMA50, RSI `< RSI_PE_MAX` and `> RSI_PE_MIN`, **SuperTrend bearish**, signal candle close below the base EMA). **Stop** = initial SL is the previous candle low (CE) / high (PE) from `getSignal`, then trailed by **EMA21** (EMA touch-back is an explicit exit), tighten-only. Optionally layer an **N-bar candle trail** (`EMA_RSI_ST_CANDLE_TRAIL_ENABLED` / `EMA_RSI_ST_CANDLE_TRAIL_BARS`, default 3 bars): each candle close the stop is set to whichever is tighter — the EMA21 line or the N-bar low/high. **Exits**: trail SL · **negative-candle stop** (`EMA_RSI_ST_NEG_CANDLE_LIMIT`, default 2 — still red after N candles → square off; winners keep riding the trail) · per-trade points stop (`EMA_RSI_ST_STOP_LOSS_PTS`, off by default) · EMA21 touch-back · option stop (`OPT_STOP_PCT`) · opposite signal · exit-before-close (`EMA_RSI_ST_EOD_EXIT_TIME`) · EOD auto-stop. Same-side cooldown after an SL hit (`EMA_RSI_ST_SL_PAUSE_CANDLES`). **Choppy-day guard** (`EMA_RSI_ST_MAX_CONSEC_LOSSES`, off by default): after N consecutive losing trades in a session, halt new entries for the rest of the day — any winner resets the streak. The same key also gates the back-to-back-loss pause, so `0` disables both. _Parabolic SAR fully removed 2026-06-12 (SuperTrend is the only trend source; EMA21 the only SL); breakeven removed 2026-06-02._

> **Defaults below are the code `||` fallbacks (what runs if the env key is unset). The Settings UI seeds more conservative values that a saved install actually runs** — notably `MAX_DAILY_TRADES=5`, `MAX_DAILY_LOSS=3000`, `RSI_CE_MAX=70` / `RSI_PE_MIN=30`, `EMA_RSI_ST_STOP_LOSS_PTS=25` (ON), `EMA_RSI_ST_CANDLE_TRAIL_ENABLED=true` (ON), `EMA_RSI_ST_SL_PAUSE_CANDLES=2`, `EMA_RSI_ST_OPPOSITE_SIDE_COOLDOWN_CANDLES=2`, `EMA_RSI_ST_EOD_EXIT_TIME=14:30`, `TRADE_ENTRY_START=10:30`. Read the real config from the day's `settings_snapshot`, not this table.

| Key | Default | Notes |
|-----|---------|-------|
| `TRADE_RESOLUTION` | `5` | **Global candle size in minutes** — `3`, `5`, or `15`. One setting for **every** strategy (EMA_RSI_ST / BB_RSI / PA / EMA9+VWAP); lives in the Settings **Instrument & Backtest** section. The old per-strategy keys (`BB_RSI_RESOLUTION`, `PA_RESOLUTION`, `EMA9VWAP_RESOLUTION`) are removed and ignored. |
| `MAX_DAILY_LOSS` | `5000` | Daily kill-switch in INR (per-strategy) |
| `PORTFOLIO_MAX_DAILY_LOSS` | `0` (off) | **Portfolio-wide** daily loss cap in INR across ALL strategies (sums today's realized paper P&L via the per-day JSONL logs). When the book's combined loss reaches this, every strategy stops taking new entries for the day. Fail-safe (only blocks, never places orders). `0`/unset = disabled. |
| `MAX_DAILY_TRADES` | `20` | Daily entry cap — anti-overtrade on chop days. *(Settings UI seeds a tighter `5`.)* |
| `LIVE_EXIT_WAIT_MS` | `20000` | Ceiling (ms) on how long a **live** square-off is waited on before the app stops waiting and alerts. Neither broker SDK sets an HTTP timeout, so an unbounded wait could hang `/stop` and stall `gracefulShutdown` on a deploy. It cancels nothing — a sent market order cannot be recalled — it only stops waiting, and the alert says to verify the broker dashboard. A healthy round-trip is well under a second, so the default never fires in normal operation. `0` = wait forever. |
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
| `EMA_RSI_ST_MAX_CONSEC_LOSSES` | `0` | Choppy-day guard — after this many **consecutive losing trades** in a session, halt new EMA_RSI_ST entries for the rest of the day; any winning trade resets the streak. Sits out range days that bleed small stops instead of repeatedly re-entering. **Also gates the back-to-back-loss pause** (5-min: pause 4 candles / 15-min: daily kill), which until 2026-07-26 fired at a hardcoded 3 even with this key set to 0. `0` = disabled, in paper, live and backtest alike. |
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
| `EXPIRY_HEALTHCHECK_ENABLED` | `true` | Resolve the expiry on a schedule (08:00–15:30 IST, plus the post-close roll at 15:40 / 16:15 / 16:30 / 16:45) and at boot, so a bad week shows up before the open instead of as a skipped entry |
| `EXPIRY_HEALTHCHECK_MINS` | `30` | How often to re-check (minimum 5) |
| `EXPIRY_AUTO_ROLL_ENABLED` | `true` | When `OPTION_EXPIRY_OVERRIDE` is blank or already expired, write the newly-resolved expiry into it (Settings + Dashboard both update). A future date you set yourself is never overwritten |

> **The expiry keeps itself current (2026-08-11).** [utils/expiryHealth.js](src/utils/expiryHealth.js) runs the *same* resolution an entry runs — at boot, every `EXPIRY_HEALTHCHECK_MINS` between 08:00 and 15:30 IST, and then the **post-close roll**: 15:40, retrying at 16:15 / 16:30 / 16:45 if it fails, so an expiry that died at the 15:30 close is replaced the same evening. The 16:00 EOD token clear is **held** while that ladder is running (the retries need the token), up to 16:55 at the latest. Only after all four attempts fail does the Dashboard show the red "set it by hand" alert; until then it shows an amber "updating it automatically" strip. It writes the answer back into `OPTION_EXPIRY_OVERRIDE` whenever the stored value is blank or has already expired, through the normal Settings save path (so `.env`, the settings-audit log and the per-mode JSONL snapshot all record it, and both the Settings page and the Dashboard expiry strip show the new date immediately). A **forward-dated** expiry you set on purpose is left alone. If nothing resolves it changes nothing, raises a Dashboard banner and sends one Telegram — that is the only case that still needs a human. Skipped on weekends/holidays, without a Fyers token, and during a replay.

> **One common expiry for every strategy (2026-08-05).** The only expiry knobs are `OPTION_EXPIRY_OVERRIDE` / `OPTION_EXPIRY_TYPE` under **Common — Instrument & Backtest** in Settings (also editable on the Dashboard expiry strip). `src/config/instrument.js` reads them for every engine — all strategies are intraday on the same weekly expiry, so the old per-strategy overrides (`EMA_RSI_ST_`, `EMA9VWAP_`, `GAPS_OPTION_EXPIRY_*`) and the common→per-mode fan-out were removed. Blank = auto-detect the nearest tradeable expiry.
>
> **Auto-detect is now trustworthy (2026-08-11).** Leaving `OPTION_EXPIRY_OVERRIDE` blank resolves the contract itself, and three defects that made it unusable are fixed: the Option-Chain REST call used a path that does not exist (`/data/v3/options-chain` → HTTP 404) so it failed on *every* invocation; its silent catch-fallback then returned a hand-rolled next-Tuesday code that skipped the current week's expiry all day on expiry day; and every step formatted the expiry as a weekly `YYMDD` code even in the last expiry week of a month, where Fyers names the contract with the **monthly** `YYMMM` code (25-Aug-2026 is `NIFTY26AUG…`, there is no `NIFTY26825…`) — so one week in four the auto path could only produce symbols that do not exist. Verified against Fyers' symbol master: 4,012 NIFTY contracts, 0 mismatches. `OPTION_EXPIRY_TYPE` still only applies when an override date is set; on the auto path the format follows the date, since a month's last expiry *is* the monthly contract.
>
> **A stale override blocks trading, by design (2026-07-26).** An override whose expiry-day session (15:30 IST) has passed names a contract that no longer exists. `validateAndGetOptionSymbol` now refuses to build a symbol from it — every strategy skips the entry and logs the key to fix — instead of returning the dead symbol unvalidated, which used to let EMA_RSI_ST and BB_RSI enter on "spot proxy" P&L with the option-premium stop inert. It deliberately does **not** substitute the auto-detected nearest expiry: silently trading a different expiry changes premium, theta and therefore the risk of every position. The Dashboard banner flags a stale common override.

### BB_RSI Mode (3 / 5-min, Fyers)
Full spec: [BB_RSI.md](BB_RSI.md).
| Key | Default | Notes |
|-----|---------|-------|
| `BB_RSI_MODE_ENABLED` | `true` | Show/hide bb_rsi menus in sidebar (also hides BB_RSI section in Settings) |
| `BB_RSI_ENABLED` | `false` | Master enable for the BB_RSI engine (required to start BB_RSI Live) |
| `BB_RSI_LIVE_ENABLED` | `false` | Must be `true` AND `LIVE_HARNESS_DRY_RUN=false` for real Fyers BB_RSI orders. Without it BB_RSI Live runs fully but every broker call is simulated |
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
| `PA_ENABLED` | `false` | Master enable for the PA engine (required to start PA Live) |
| `PA_LIVE_ENABLED` | `false` | Must be `true` AND `LIVE_HARNESS_DRY_RUN=false` for real Fyers PA orders. Without it PA Live runs fully but every broker call is simulated |
| `PA_ENTRY_START` / `PA_ENTRY_END` | `09:20` / `14:30` | Entry window (IST) |
| `PA_PATTERN_DOUBLE_BOTTOM` | `true` | Toggle Double Bottom (W) → CE |
| `PA_PATTERN_DOUBLE_TOP` | `true` | Toggle Double Top (M) → PE |
| `PA_PATTERN_ASC_TRIANGLE` | `true` | Toggle Ascending Triangle → CE |
| `PA_PATTERN_DESC_TRIANGLE` | `true` | Toggle Descending Triangle → PE |
| `PA_TREND_FILTER_ENABLED` | `false` | Trade breakouts **with** the trend (course rule #1): triangles must align with the EMA bias (Asc→uptrend, Desc→downtrend); Double Top/Bottom must sit at a real range extreme. Default OFF — replay-validate before enabling |
| `PA_TREND_EMA_PERIOD` | `20` | EMA period (on PA candles) used for the trend-bias read |
| `PA_TREND_FLAT_BAND` | `0` | Neutral band (pts) around the EMA — inside it the trend is FLAT and triangles are blocked |
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
| `ORB_LIVE_DRY_RUN` | `false` | Keep ORB in dry-run (log only) even when the global harness dry-run is off. Default off — the *global* `LIVE_HARNESS_DRY_RUN=true` is what holds ORB in dry-run out of the box |
| `ORB_RANGE_START` / `ORB_RANGE_END` | `09:15` / `09:30` | Opening-range window (IST) |
| `ORB_ENTRY_END` | `11:30` | Stale-breakout cutoff — no new entries past this |
| `ORB_FORCED_EXIT` | `15:15` | Hard EOD square-off |
| **— entry (the whole signal surface) —** | | |
| `ORB_OR_ATR_MAX` | `0` (off) | Skip the day when OR width > this × `ATR(15m)`. No minimum by design — see the strategy section |
| `ORB_OR_MAX_PTS` | `0` (off) | Absolute cap on opening-range width in points. **Leave it off** — it looked like the one real filter on the 2025 + 2026 samples and then reversed on 2024 (see the strategy section). Kept only so the idea can be re-measured with `scripts/orbSweep.js` rather than re-derived |
| `ORB_GAP_OR_MULT` | `0` (off) | Skip when `\|gap\| > this × OR width` (`0` = off) |
| `ORB_BODY_ATR_MULT` | `0` (off) | Breakout candle body ≥ this × `ATR(5m)`. The load-bearing entry filter |
| `ORB_BODY_OR_CAP` | `0` (off) | Ceiling on that body requirement as a share of **today's** opening range. `ATR(5m)` is frozen from the *previous* days, so after a violent day it can demand a body larger than today's entire range — on 2026-08-06 it wanted 22.2pt against a 38.95pt opening range (57% of it in one 5-min candle) and the session could not produce an entry. `0.25` = never ask for more than a quarter of the range. It is a ceiling, so it can only ever let **more** breakouts through, and an unseeded `ATR(5m)` still fails open |
| `ORB_BUFFER_OR_MULT` | `0` (off) | How far beyond the OR edge a close must be, as a share of the range (the larger of this and `0.30 × ATR(5m)`, floor 1pt). **Leave it alone** — dropping it to `0.10` / `0.05` on the Mar–Apr 2026 sample bought 1–2 extra trades and took PF from 0.93 to 0.64 / 0.59; a smaller buffer just buys fake breakouts |
| `ORB_BUFFER_ATR_MULT` | `0` (off) | The other half of the buffer: the close must clear the edge by the larger of `ORB_BUFFER_OR_MULT × OR` and this × `ATR(5m)`, with `ORB_BUFFER_MIN_PTS` as the floor. Set all three to `0` for a plain "any close past the line" break |
| `ORB_BUFFER_MIN_PTS` | `0` | Absolute floor on that buffer, in points |
| `ORB_VWAP_FILTER_ENABLED` | `false` | Require the breakout (and confirmation) close on the correct side of session VWAP. **Measured worthless on this strategy**: on the Mar–Apr 2026 sample it removed 0 of 36 breakouts in three separate tests — a close past the range edge before noon is essentially always on the right side of VWAP. Off skips the VWAP maths entirely |
| `ORB_CONFIRM_MODE` | `close` | `extend` = the next candle needs a higher high **and** a higher close beyond the edge. `close` = it only needs to CLOSE beyond the breakout candle's close (the plain continuation rule) |
| `ORB_SL_SOURCE` | `breakout` | Which candle's extreme anchors the initial stop: `entry` (the candle bought on) or `breakout` (the first candle that closed past the edge) |
| `ORB_RSI_ENABLED` | `true` | RSI momentum gate on the **entry** candle: CE needs RSI ≥ `ORB_RSI_CE_MIN`, PE needs RSI ≤ `ORB_RSI_PE_MAX`. Read on the bar being bought (the only one whose momentum is knowable when the order goes in), on the same multi-day close series the EMA trail uses. Fails **open** when RSI is not yet seeded |
| `ORB_RSI_PERIOD` | `14` | RSI lookback |
| `ORB_RSI_CE_MIN` | `51` | CE entries need RSI at or above this |
| `ORB_RSI_PE_MAX` | `49` | PE entries need RSI at or below this |
| `ORB_ST_ENABLED` | `true` | SuperTrend direction gate on the **entry** candle: CE only when SuperTrend is bullish (line below price), PE only when bearish. Uses the shared `utils/supertrend.js`. Fails **open** during warm-up |
| `ORB_ST_PERIOD` / `ORB_ST_MULT` | `10` / `3` | SuperTrend ATR period and multiplier |
| `ORB_BREAKOUT_RESCAN` | `true` | Skip a close that clears the OR edge but fails the body/colour/VWAP test and keep hunting for a decisive one. `false` = the first close beyond the edge is final (pre-2026-08-11 behaviour) |
| `ORB_RETEST_MAX_WAIT` | `6` | Candles to stay armed for a retest/resume after a hesitating confirmation (`0` = confirmed entries only) |
| `ORB_DEBUG_TRACE` | `false` | Print the full per-candle entry funnel (PASS/FAIL/SKIP per gate + decision) to the logs |
| **— exits —** | | |
| `ORB_SL_ATR_MULT` | `0` (off) | Initial hard SL = wider of the entry candle's extreme and this × `ATR(5m)`. Owned by the strategy (`sig.slSpot`); paper/live/backtest all consume it |
| `ORB_BREAKEVEN_PTS` / `ORB_BREAKEVEN_OR_MULT` | `0` / `0` (off) | Lift SL to entry once `max(fixed, mult×OR)` pts in profit (`0` mult = fixed only) |
| `ORB_TRAIL_EMA` | `20` | Exit only when a candle closes back across this EMA of 5-min closes |
| `ORB_TRAIL_ARM_PTS` | `0` (at once) | The EMA trail may not exit until the trade is this many points in profit — until then only the hard stop and the ₹ cap are live. ORB enters on the confirmation candle's **close**, by which point price is extended, so the next candle often pulls straight back through an EMA still sitting under the entry; across the 2025 (n=123) and 2026 (n=60) exports that is where the long tail of −₹200…−₹1,200 scratch exits comes from. **A hypothesis, not a finding** — it must clear TRAIN *and* TEST in `scripts/orbSweep.js` before the default moves |
| `ORB_TRAIL_CONFIRM_CLOSES` | `1` | Closes in a row on the wrong side of the EMA before the trail exits. `1` = the shipped rule; `2` survives one noise candle at the cost of a bar of give-back |
| `ORB_OPP_CANDLE_EXIT` / `ORB_OPP_CANDLE_BODY_MULT` | `false` / `0.3` | Exit on a strong opposite candle (body ≥ mult×OR, closing back inside the box) |
| `ORB_MAX_TRADE_LOSS` | `0` (off) | Per-trade unrealised-₹ loss cap. **Ships off**: when set it clamps the placed stop (see `orbStopRisk.js`) and is tighter than the strategy's own level on nearly every trade, so it — not the breakout candle — becomes the real stop. Day-level risk is `ORB_MAX_DAILY_LOSS` |
| `ORB_PREMIUM_STOP_PCT` | `35` | Exit if option premium collapses ≥ this % from entry (IV-crush/vega backstop) |
| **— option selection —** | | |
| `ORB_ITM_STEPS` | `1` | Strikes ITM (×50) for ~delta 0.6 (CE lower / PE higher). `0` = ATM |
| `ORB_PREMIUM_GATE_ENABLED` | `true` | Skip when option LTP is outside the band below |
| `ORB_PREMIUM_MIN` / `ORB_PREMIUM_MAX` | `120` / `400` | Acceptable option-premium band (₹), widened for slightly-ITM premiums |
| `ORB_MAX_SPREAD_PTS` | `2` | Skip when ask−bid exceeds this (falls back to `MAX_BID_ASK_SPREAD_PTS`; fails open with no depth) |
| **— risk / regime —** | | |
| `ORB_MAX_DAILY_TRADES` | `1` | Textbook 1/day — raise only if you accept the chop |
| `ORB_MAX_DAILY_LOSS` | `3000` | ORB kill-switch (INR). Blocks NEW entries once the day is down this much; it cannot close a position that is already open, and with `ORB_MAX_DAILY_TRADES=1` the budget is already spent, so it only bites once you allow more than one trade a day |
| `ORB_RISK_THROTTLE_ENABLED` | `true` | Portfolio breaker: sit out on a weekly-loss stop / losing streak (`~/trading-data/orb_risk_state.json`, paper + live tracked separately) |
| `ORB_MAX_WEEKLY_LOSS` | `9000` | Stop entries for the rest of the ISO-week once week realised P&L ≤ −this (₹; `0` = off) |
| `ORB_LOSS_STREAK_SKIP` | `4` | Sit out the next day after this many consecutive losing days (one-day cool-off; `0` = off) |
| `ORB_EXPIRY_DAY_ONLY` | `false` | Only trade ORB on weekly-expiry day |
| `ORB_VIX_ENABLED` | `false` | Independent VIX filter |
| `ORB_VIX_MAX_ENTRY` / `ORB_VIX_STRONG_ONLY` | `22` / `18` | Per-mode VIX thresholds |
| `ORB_OI_ENABLED` | `false` | Apply the OI-buildup filter to ORB entries (needs the master OI switch on). **Note:** many deployed `.env` files set this to `true` — check Settings for the running value |
| **— backtest sim —** | | |
| `ORB_BT_SEED_PREMIUM` / `ORB_BT_SLIPPAGE_PTS` | `240` / `1.5` | Backtest only (both in Settings): entry-premium proxy for the δ+θ sim, and the per-side spread/slippage haircut |
| `ORB_SIG_WINDOW` | `260` | Backtest only, **code-only** (no Settings field, same as `TREND_PB_SIG_WINDOW`): trailing 5-min bars fed to `getSignal` + the EMA trail so ATR(5m)/ATR(15m)/EMA20 are seeded. Harness plumbing sized to the indicators, not a tuning dial |

> **Retired ORB keys — safe to delete from `.env` (2026-08-04).** The 2026-07-26 rebuild collapsed ORB to one engine and deleted the V1/V2/V3 filters outright (RSI, ADX, EMA20/50, wick %, volume, close-position, sweet-spot, prior-day levels, fixed point ranges, the old retest gate and the old %-based stop/target/trail). Their env keys were never cleaned up, so a deployed `.env` can still carry **41 ORB keys that no code reads**. They are inert — but they are also captured by `tickRecorder.snapshotSettings()` (`/^ORB_/`), so every replay recording and every daily-JSONL settings block advertises filters that do not exist, and anyone reading `.env` reasonably concludes ORB still has an RSI gate. **The app warns about them at boot** (`⚠️ Dead ORB keys : N pre-rebuild ORB_* key(s) …`, an exact-key list in `app.js` — a prefix rule can't be used here because the live keys share the `ORB_` prefix). To clear them, paste this into **Settings → 📋 BULK EDIT** (a leading `-` deletes a key), on the EC2 box as well as locally:
>
> **One key per line** — the bulk parser reads `-KEY` line-by-line, so several on one line collapse into a single junk key:
>
> ```
> -ORB_ADX_MIN
> -ORB_ADX_PERIOD
> -ORB_ATR_PERIOD
> -ORB_BODY_PCT_MIN
> -ORB_BREAKOUT_BUFFER_MIN
> -ORB_BREAKOUT_BUFFER_PCT
> -ORB_CLOSE_POS_PCT
> -ORB_CONFIRM_ENABLED
> -ORB_ENTRY_V2_ENABLED
> -ORB_ENTRY_V3_ENABLED
> -ORB_MAX_GAP_PTS
> -ORB_MAX_RANGE_PTS
> -ORB_MAX_WICK_RATIO
> -ORB_MIN_BODY
> -ORB_MIN_RANGE_PTS
> -ORB_OR_ATR_MIN
> -ORB_PAPER_CAPITAL
> -ORB_PREMIUM_LOCKIN_FLOOR_PCT
> -ORB_PREMIUM_LOCKIN_PCT
> -ORB_PRIORDAY_LEVEL_FILTER
> -ORB_RETEST_ENABLED
> -ORB_RETEST_MODE
> -ORB_RETEST_TOL_MIN
> -ORB_RETEST_TOL_PCT
> -ORB_SL_CANDLES
> -ORB_STOP_PCT
> -ORB_STRONG_BODY
> -ORB_SWEET_MAX
> -ORB_SWEET_MIN
> -ORB_TARGET_PCT
> -ORB_TARGET_RANGE_MULT
> -ORB_TRAIL_ARM_PCT
> -ORB_TRAIL_ENABLED
> -ORB_TRAIL_LOCK_PCT
> -ORB_TREND_EMA_FAST
> -ORB_TREND_EMA_SLOW
> -ORB_VOL_FILTER_ENABLED
> -ORB_VOL_LOOKBACK
> -ORB_VOL_MULT
> -ORB_WICK_FILTER_ENABLED
> -ORB_WICK_PCT_MAX
> ```
>
> Note the traps in that list: `ORB_TRAIL_ENABLED=true` reads as if it gates `ORB_TRAIL_EMA` (it does not — the EMA trail is unconditional); `ORB_ATR_PERIOD` reads as if it sets the ATR lookback (that is the hard-coded `ATR_PERIOD = 14` in `orb_breakout.js`); `ORB_BUFFER_OR_MULT`, `ORB_BUFFER_ATR_MULT` and `ORB_VWAP_FILTER_ENABLED` all became **live** keys on 2026-08-13 and must NOT be deleted; and `ORB_TARGET_RANGE_MULT` used to move the target line on **manual entries only**, which is why it became the exported `TARGET_OR_MULT` constant instead. Deleting all 41 changes no behaviour — verify with `node scripts/orbValidate.js` before and after if you want the proof.

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
| `EMA9VWAP_CONFIRM_CANDLE_ENABLED` / `EMA9VWAP_INTRACANDLE_ENTRY` | `false` / `false` | Both off (the default) → entry on the cross candle's close. Confirm-on now works on its own (entry waits for the next bar to cross the signal bar's close); it used to require `EMA9VWAP_INTRACANDLE_ENTRY=true` as well or the engine armed signals it could never enter. Both toggles are honoured at every resolution Settings offers (3/5/15) |
| `EMA9VWAP_SL_PAUSE_CANDLES` | `3` | Same-side SL cooldown (candles) — inert unless an optional stop is enabled |
| `EMA9VWAP_OPPOSITE_SIDE_COOLDOWN_ENABLED` / `_CANDLES` | `true` / `3` | Block the flip side for N candles after a signal-cross / reversal exit |
| `EMA9VWAP_MAX_CONSEC_LOSSES` | `0` | Chop guard — sit out the session after N straight losses (0 = off) |
| `EMA9VWAP_NEG_CANDLE_LIMIT` | `0` | Square off a still-red trade after N candles (0 = off) |
| `EMA9VWAP_CANDLE_TRAIL_ENABLED` / `_BARS` | `false` / `3` | Optional N-bar structural trailing stop (tighten-only) |
| `EMA9VWAP_SL_MODE` | `ema` | `candle` re-enables the legacy time-stop; `ema` = pure signal exit |
| `EMA9VWAP_OI_ENABLED` | `false` | OI-buildup gate for EMA9+VWAP entries (requires master `OI_FILTER_ENABLED`). Live/paper only |
| `EMA9VWAP_VIX_ENABLED` | _(blank)_ | **Tri-state.** Blank = inherit the global `VIX_FILTER_ENABLED` (on unless explicitly `false`) — the historical behaviour. `true`/`false` decouples EMA9+VWAP from EMA_RSI_ST's VIX setting |
| `EMA9VWAP_VIX_MAX_ENTRY` | _(blank)_ | Blank = inherit the global `VIX_MAX_ENTRY` (20). Block entries when India VIX is above this |
| `EMA9VWAP_VIX_STRONG_ONLY` | _(blank)_ | Blank = inherit `VIX_STRONG_ONLY` (16). Inert in practice — EMA9+VWAP always submits `STRONG` to the VIX check |

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

### GAPS Mode (daily extreme RSI + next-day gap, Fyers)

| Key | Default | Description |
|-----|---------|-------------|
| `GAPS_MODE_ENABLED` | `true` | Master toggle — sidebar group + Settings section |
| `GAPS_PAPER_ENABLED` | `true` | Allow `/gaps-paper/start` |
| `GAPS_EMA_LENGTH` | `21` | Daily EMA period — the RSI source **only**; not an exit level (see `GAPS_TRAIL_EMA_LENGTH`) |
| `GAPS_RSI_LENGTH` | `14` | Daily RSI period |
| `GAPS_RSI_SOURCE` | `ema` | What RSI is calculated ON. `ema` = TradingView's "EMA: EMA" (RSI plotted on the EMA line, double-smoothed so it reaches the extremes). Also `close`/`open`/`high`/`low`/`hl2`/`hlc3`/`ohlc4` |
| `GAPS_RSI_ENTRY_SOURCE` | `today_open` | Which RSI decides the entry. `today_open` = TODAY's RSI (daily series extended with today's open); `prev_close` = the PREVIOUS day's closed RSI. Gap is always measured vs yesterday's close either way |
| `GAPS_RSI_UPPER` | `90` | Yesterday's RSI must be above this for the PE setup |
| `GAPS_RSI_LOWER` | `10` | Yesterday's RSI must be below this for the CE setup |
| `GAPS_ENTRY_START` / `GAPS_ENTRY_END` | `09:15` / `09:30` | Entry window (IST) — the gap decision is only valid at the open |
| `GAPS_EXIT_TF` | `5` | Intraday timeframe the trailing EMA is built on and whose CLOSE triggers the exit (also the intraday chart's candle size) |
| `GAPS_TRAIL_ENABLED` | `true` | Trail with the intraday EMA; exit on a close back THROUGH it (PE → close above, CE → close below). Off = gap-size-stop-and-EOD only |
| `GAPS_TRAIL_EMA_LENGTH` | `21` | EMA period for the trailing stop, on `GAPS_EXIT_TF` candles. Separate from `GAPS_EMA_LENGTH` (daily, feeds the RSI) |
| `GAPS_FORCED_EXIT` | `15:15` | EOD square-off (IST) |
| `GAPS_ITM_STEPS` | `1` | Strikes shifted in-the-money (~delta 0.6); 0 = ATM |
| `GAPS_LOT_MULTIPLIER` | `0` | Per-strategy lot multiplier; 0 = inherit the global `LOT_MULTIPLIER` (clamped by `MAX_LOT_MULTIPLIER`) |
| `GAPS_MAX_DAILY_TRADES` | `1` | Daily trade cap — GAPS decides once, at the open |
| `GAPS_MAX_DAILY_LOSS` | `5000` | Daily loss kill-switch (₹); 0 = off |
| `GAPS_MAX_WEEKLY_LOSS` | `0` | Rolling Mon→today loss cap (₹) read from the per-day GAPS JSONL logs; 0 = off |
| `GAPS_LOSS_STREAK_SKIP` | `3` | Risk breaker — pause entries after N consecutive losers (0 = off) |
| `GAPS_LIVE_ENABLED` | `false` | Master switch for live orders — see Live Harness table |
| `GAPS_LIVE_DRY_RUN` | `false` | Keep GAPS in dry-run even when the global harness dry-run is off |
| `GAPS_BT_SLIPPAGE_PTS` | `1.5` | Backtest spread/slippage haircut, each way (premium pts) |
| `GAPS_BT_SEED_PREMIUM` | `240` | Assumed slightly-ITM entry premium for the backtest δ+θ sim |
| `GAPS_DAILY_CHART_BARS` | `180` | Daily candles rendered on the GAPS daily EMA/RSI chart |


### Trend Day Scalp Mode (10:15 day gate → VWAP/EMA20 pullback, Fyers)

| Key | Default | Description |
|-----|---------|-------------|
| `TDS_MODE_ENABLED` | `true` | Master toggle — sidebar group + Settings section |
| `TDS_PAPER_ENABLED` | `true` | Allow `/trend-day-scalp-paper/start` |
| `TDS_LIVE_ENABLED` | `false` | Gates real Fyers orders on `/trend-day-scalp-live/start` |
| `TDS_LIVE_DRY_RUN` | `false` | Per-strategy dry-run override — keeps it simulated even when live is on |
| `TDS_GATE_TIME` | `10:15` | The one moment the day is judged tradeable. Decided once, then **frozen** |
| `TDS_SESSION_START` | `09:15` | Where the first-hour range and the session VWAP both start (IST) |
| `TDS_MIN_RANGE_PCT` | `0.5` | First-hour range must be ≥ this % of spot — a dead range has no juice for a buyer |
| `TDS_VWAP_STREAK_BARS` | `6` | How many of the last closes must ALL sit on the same side of VWAP |
| `TDS_EXTENSION_MULT` | `0.20` | `\|spot − VWAP\|` must be ≥ this × the range. **Measured** median 0.18 / p90 0.39 over 39 sessions — the old `0.35` passed only 13% of days |
| `TDS_EMA_PERIOD` | `20` | The pullback zone is whichever of VWAP / this EMA sits **nearer** to price |
| `TDS_ATR_PERIOD` | `14` | ATR that scales the conviction body |
| `TDS_BODY_ATR_MULT` | `0.4` | Reclaim candle body must be ≥ this × ATR |
| `TDS_PULLBACK_WINDOW` | `3` | How many recent bars may supply the pullback touch (a **wick** counts) |
| `TDS_ENTRY_END` | `14:00` | No new entries after this (IST) |
| `TDS_FORCED_EXIT` | `15:10` | Hard EOD square-off (IST) |
| `TDS_RESOLUTION` | `5` | Signal + exit candle timeframe (min) |
| `TDS_MIN_SL_PTS` | `12` | A tighter structural stop is **widened** to this |
| `TDS_MAX_SL_PTS` | `40` | A wider structural stop **SKIPS the trade** — never tightened into the structure. **Was `18`, which skipped 48 of 53 real setups** (median structural stop is 35pt) |
| `TDS_TARGET_R` | `2.5` | Fixed target as a multiple of the stop distance. Taken, never trailed past |
| `TDS_BREAKEVEN_R` | `1` | Favourable move at which the stop makes its **one** jump |
| `TDS_BREAKEVEN_BUFFER_PTS` | `3` | Where it lands: `entry ± this`. It never moves again |
| `TDS_TIME_STOP_MINS` | `25` | Flat if breakeven has not armed within this long (0 = off) |
| `TDS_PREMIUM_STOP_PCT` | `25` | Exit if the option itself drops this % (0 = off) |
| `TDS_ITM_STEPS` | `1` | Strikes in-the-money to buy (0 = ATM). 1 step ≈ delta 0.6 |
| `TDS_LOT_MULTIPLIER` | `0` | Lots per trade (0 = inherit global `LOT_MULTIPLIER`; clamped by `MAX_LOT_MULTIPLIER`) |
| `TDS_MAX_DAILY_TRADES` | `2` | Max entries per day — friction is per-trade, so fewer is usually better |
| `TDS_MAX_DAILY_LOSSES` | `2` | Day ends after this many **real stop-outs** (0 = off). Breakeven / time-stop exits do NOT count |
| `TDS_MAX_DAILY_LOSS` | `3000` | Stop trading after this much loss (0 = off). Raised with the stop cap — at `1500` one 40pt stop-out ends the day |
| `TDS_DAILY_PROFIT_LOCK` | `3000` | Stop for the day once this much is banked (0 = off) |
| `TDS_MAX_WEEKLY_LOSS` | `0` | Rolling Mon→today cap read from the per-day JSONL logs (0 = off) |
| `TDS_BT_SLIPPAGE_PTS` | `1.5` | Backtest cost per side, in points |
| `TDS_BT_SEED_PREMIUM` | `240` | Assumed entry premium for the backtest (₹) |
| `UI_SHOW_TDS_BACKTEST` / `_PAPER` / `_LIVE` / `_HISTORY` | `true` | Sidebar sub-menu visibility |
| `TG_TDS_STARTED` / `_ENTRY` / `_EXIT` / `_DAYREPORT` | `true` | Telegram alerts for this strategy |

### 3M Gap Fix Scalp Mode (3-min NIFTY FUTURES gap fade, Fyers)

| Key | Default | Description |
|-----|---------|-------------|
| `GAP3M_MODE_ENABLED` | `true` | Master toggle — sidebar group + Settings section |
| `GAP3M_PAPER_ENABLED` | `true` | Allow `/gap-fix-3m-paper/start` |
| `GAP3M_LIVE_ENABLED` | `false` | Gates real Fyers orders on `/gap-fix-3m-live/start` |
| `GAP3M_LIVE_DRY_RUN` | `false` | Per-strategy dry-run override — keeps it simulated even when live is on |
| `GAP3M_RESOLUTION` | `3` | Candle timeframe (min). **Strategy-level, deliberately not the repo-wide 5** — a void that survives aggregation into a 5-min bar is a much rarer animal |
| `GAP3M_MIN_GAP_PTS` | `20` | Ignore voids smaller than this. The gap size **is** the target, and ~7.3 index points go to charges + slippage before the trade has made anything |
| `GAP3M_CONFIRM_BARS` | `1` | How many bars after the gap may still decide it. `1` = only the very next candle, which is the rule as written |
| `GAP3M_RETURN_MODE` | `reverse_close` | `reverse_close` = closes against the gap AND gives back ground vs the gap bar. `into_gap` = closes right back inside the void (stricter, and it enters closer to the target — worse R:R) |
| `GAP3M_VOL_MULT` | `1.5` | A candle breaking the day extreme on ≥ this × average volume is a REAL breakout — leave it alone |
| `GAP3M_VOL_AVG_BARS` | `20` | Bars of the same session the average volume is taken over |
| `GAP3M_SESSION_START` | `09:15` | Where the day high / low start being tracked (IST) |
| `GAP3M_ENTRY_START` | `09:30` | No entries before this — the day needs a high and a low worth stopping against (IST) |
| `GAP3M_ENTRY_END` | `15:00` | No new entries after this (IST) |
| `GAP3M_FORCED_EXIT` | `15:15` | Hard EOD square-off (IST) — a gap that never filled is closed here |
| `GAP3M_SL_BUFFER_PTS` | `0` | Stop sits this far past the day extreme. `0` = exactly on it, as the rule states |
| `GAP3M_MAX_SL_PTS` | `0` | **Off by default.** Skip when the day extreme is further away than this |
| `GAP3M_MIN_RR` | `0` | **Off by default.** Skip when the gap-fill target is small relative to the stop |
| `GAP3M_MAX_EXTREME_DIST_PTS` | `0` | **Off by default.** Skip when the gap formed too far from the day extreme to be fading against it |
| `GAP3M_LOT_MULTIPLIER` | `0` | Lots per trade (0 = inherit global `LOT_MULTIPLIER`; clamped by `MAX_LOT_MULTIPLIER`) |
| `GAP3M_ITM_STEPS` | `1` | Strikes in-the-money to buy (0 = ATM). 1 step ≈ delta 0.6. Strike chosen off the **index** spot |
| `GAP3M_MAX_DAILY_TRADES` | `3` | Max entries per day |
| `GAP3M_MAX_DAILY_LOSSES` | `2` | Day ends after this many stop-outs (0 = off) |
| `GAP3M_MAX_DAILY_LOSS` | `3000` | Stop trading after this much loss (0 = off) |
| `GAP3M_DAILY_PROFIT_LOCK` | `0` | Stop for the day once this much is banked (0 = off, the default) |
| `GAP3M_MAX_WEEKLY_LOSS` | `0` | Rolling Mon→today cap read from the per-day JSONL logs (0 = off) |
| `GAP3M_FUT_POLL_MS` | `2000` | How often the live NIFTY futures price is fetched. **This is the granularity every exit is checked at** — the shared tick socket carries the index, not the future |
| `GAP3M_HISTORY_LAG_MS` | `5000` | How long after a bar closes before the Fyers history endpoint is asked for it. Too short and the bar is not published yet, delaying every decision by a whole candle |
| `GAP3M_BT_SLIPPAGE_PTS` | `1.5` | Backtest cost per side, in points |
| `GAP3M_BT_SEED_PREMIUM` | `240` | Assumed entry premium for the backtest (₹) |
| `UI_SHOW_GAP3M_BACKTEST` / `_PAPER` / `_LIVE` / `_HISTORY` | `true` | Sidebar sub-menu visibility |
| `TG_GAP3M_STARTED` / `_ENTRY` / `_EXIT` / `_DAYREPORT` | `true` | Telegram alerts for this strategy |

### Paper Investment Pools (per broker)
Paper capital is pooled per broker, not per strategy. Each strategy's running capital = its broker pool + that strategy's all-time paper P&L. The Real-Time Monitor (dashboard) carries a wallet ribbon per broker — headline **free to trade**, with *Invested / P&L* and *In use / Pool* beneath — and it stays up during a running session, since that is when free cash matters. It is hidden under the LIVE toggle: the pool is paper money and has no live-margin equivalent.

With `PAPER_CAPITAL_GATE_ENABLED` on (the default) the pool is spendable money rather than a display figure — [capitalPool.js](src/utils/capitalPool.js) tracks:

```
available(broker) = INV_AMOUNT + realized P&L of that broker's paper strategies
                    − qty × premium blocked by their currently OPEN positions
```

The reservation is released with the trade's net P&L on exit, so a losing day shrinks the pool and a winning day grows it.

**Running out never stops a trade.** A paper session must keep collecting data, so an entry the pool cannot fund is taken anyway, the pool goes negative, and the Real-Time monitor raises an amber **"Paper capital pool exhausted"** banner naming the strategy, what it needed and how short it was (`GET /realtime/capital` backs it; the last 20 shortfalls are kept in memory). The tracker can never place, resize or stop an order, and every internal failure fails open. It is skipped during Replay/simulation so a replay is not judged against today's pool.

| Key | Default | Notes |
|-----|---------|-------|
| `ZERODHA_INV_AMOUNT` | `100000` | Paper investment pool for Zerodha strategies (EMA_RSI_ST + EMA9+VWAP) |
| `FYERS_INV_AMOUNT` | `100000` | Paper investment pool for Fyers strategies (BB_RSI + PA + ORB + Trend Pullback + GAPS) |
| `PAPER_CAPITAL_GATE_ENABLED` | `true` | Track the pool across paper entries/exits and alert when it runs dry. `false` = the amounts are display-only (pre-2026-08-08 behaviour) |
| `PAPER_CAPITAL_EST_PREMIUM` | `200` | Premium assumed by the check for EMA_RSI_ST / EMA9+VWAP / BB_RSI / PA, which decide before their option quote arrives. The block is corrected to the real premium on the first option poll (~1s later). ORB / Trend PB / GAPS already know the quote and use it directly |

### VIX Filter (per-module)
| Key | Default | Notes |
|-----|---------|-------|
| `VIX_FILTER_ENABLED` | `true` | Block EMA_RSI_ST entries in high-VIX |
| `VIX_MAX_ENTRY` | `20` | EMA_RSI_ST block-all-entries threshold |
| `VIX_STRONG_ONLY` | `16` | EMA_RSI_ST strong-only threshold |
| `VIX_FAIL_MODE` | `closed` | When VIX unavailable: closed = block (safe), open = allow |
| `VIX_MAX_STALE_SEC` | `300` | Max age of a cached VIX before it's treated as unavailable (→ `VIX_FAIL_MODE`). Stops an ancient cached VIX admitting entries during a spike. |
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
| `EMA9VWAP_OI_ENABLED` | `false` | Apply to EMA9+VWAP (requires master ON). Added 2026-07-26 — before this the `ema9vwap` mode string had no branch in `getOiEnabled()` and silently fell through to `EMA_RSI_ST_OI_ENABLED`, so the gate could never be turned on for this strategy |
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
| `HARD_SL_ENABLED` | `false` | Place an SL-M order at the exchange on every entry (options only) — protects against bot crash/disconnect. Applies to the native live engines: EMA_RSI_ST, BB_RSI, PA and **ORB**. The trigger trails with the stop and is cancelled before any normal square-off; if a square-off fails, it is re-armed so the still-open position keeps its protection. In dry-run it is simulated, never placed. (Harness-run strategies use `HARNESS_EXCHANGE_SL_ENABLED` instead.) |
| `HARD_SL_DELTA` | `0.5` | Delta used when converting spot SL → option premium trigger |

### Tick Recorder / Replay / Live Harness
| Key | Default | Notes |
|-----|---------|-------|
| `TICK_RECORDER_ENABLED` | `true` | Record spot/option/VIX/OI ticks to `<repo>/data/ticks/YYYY-MM-DD/*.jsonl` for the whole trading day. Required for Replay. Pure observer — zero impact on trading. |
| `TICK_RECORDER_RETAIN_DAYS` | `30` | Auto-delete tick recordings older than this many days (~10 MB/day across streams) |
| `OPTION_CHAIN_RECORDER_ENABLED` | `true` | Day-wide, **strategy-independent** recorder: proactively polls the ATM±N option chain + VIX + futures-OI every few seconds during market hours and writes to the same tick streams. Makes SNAPSHOT replay reproducible for **any** strategy (even a strike no live strategy traded, or a brand-new strategy on an old day). Pure observer. Requires `TICK_RECORDER_ENABLED`. |
| `OPTION_CHAIN_RECORD_INTERVAL_SEC` | `5` | Poll cadence for the day-wide recorder (clamped 2–60). ~one `getQuotes` call per interval. |
| `OPTION_CHAIN_RECORD_STRIKES` | `5` | Strikes each side of ATM to record per side (clamped 1–15). `5` → 11 strikes × CE+PE = 22 option symbols per poll. |
| `OPTION_CHAIN_RECORD_OI` | `true` | Also capture each strike's **Open Interest** from the same quotes → `chain_oi.jsonl` + the in-memory ladder `/oi-monitor` reads. **No extra API calls** — the OI field was already in the quote rows and was being discarded. This is the only per-strike OI in the platform (everything else, incl. the `OI_FILTER_*` buildup gate, uses a single NIFTY *futures* number). Rows are de-duplicated by value, so the file holds real OI moves, not one row per poll. **Fyers has no historical-OI API**: a day recorded with this off is gone for good. |
| `SPOT_FEED_ALWAYS_ON` | `true` | Keep the shared NIFTY spot feed connected 09:15–15:30 IST even with **no strategy running**, so every trading day is recorded in full. Off = the old behaviour (recording only lasts as long as a strategy session). Skipped when a replay is running, when there's no Fyers token, or on weekends/NSE holidays. |
| `OPTION_SOCKET_FEED_ENABLED` | `true` | Stream the option contracts strategies are **currently holding** on the shared Fyers websocket instead of each engine polling `getQuotes` on its own timer. Cuts REST usage to near-zero while positions are open and gives exits a per-tick premium instead of one up to a poll interval old. Every engine keeps its REST poll as the fallback, so turning this off — or the feed failing — restores the previous behaviour exactly. Options are only ever multiplexed onto the connection once the socket has proven it can tell instruments apart; if a sustained run of ticks stops being attributable it drops the option subscriptions for the session and reverts to spot-only. Automatically disabled during a Replay run. Check `/auth/socket-health` (`symbolAttribution` + `optionFeed.restSkipped`) to see whether it actually activated. |
| `OPTION_SOCKET_FRESH_MS` | `4000` | How old a streamed premium may be before the engine falls back to a REST poll for it (clamped 500–60000). Lower = more REST calls, fresher guarantee. |
| `OPTION_SOCKET_LEASE_MS` | `15000` | A contract is unsubscribed this long after the last engine stops asking for it (clamped 5000–120000). Must stay above the slowest engine's poll interval (3 s) so an ordinary slow poll never drops a live subscription. |
| `OPTION_SOCKET_RECORD_MS` | `1000` | Minimum gap between recorded samples per streamed contract (clamped 100–10000). Keeps `options.jsonl` at replay-useful density instead of one row per tick. |
| `SERVER_LOG_ARCHIVE_ENABLED` | `true` | Mirror every console entry to `~/trading-data/server_logs/YYYY-MM-DD.jsonl` (write-behind, 2 s batched — no sync I/O on the tick path). Without it the Server Logs tab only ever shows the last 5 000 lines since the current PM2 process started. |
| `SERVER_LOG_RETAIN_DAYS` | `7` | Days of server logs kept on disk, today included (7 → today + the last 6 days). The Logs page's day picker lists exactly these files; older files are deleted hourly. |
| `SERVER_LOG_MAX_MB` | `200` | Per-day size cap for a server-log file. Once hit, that day stops archiving (the live in-memory view is unaffected) — a runaway log loop can't fill the disk. |
| `SETTINGS_AUDIT_MAX_ENTRIES` | `500` | Keep only the newest this-many rows of `settings-audit.jsonl` (the Trade Logs → Checkpoints & Settings Changes tab), whatever their age; extra rows are pruned on every save. Replaces the old day-based `SETTINGS_AUDIT_RETAIN_DAYS` |
| `BACKUP_ENABLED` | `true` | Cut a daily self-contained `.tar.gz` snapshot of `~/trading-data` + `data/ticks` (caches & OAuth tokens excluded) into `~/trading-data/_backups/`. Download it from Settings → Backup & Restore; a banner nags on every page until the day's copy is downloaded (or pushed to Google Drive — an off-site copy counts as safe and clears the nag). Pure observer — zero impact on trading. |
| `BACKUP_HOUR_IST` | `16` | Hour of day (IST) the daily snapshot is cut (after market close). Timer armed at boot — restart to re-arm a changed hour. |
| `BACKUP_RETAIN_DAYS` | `14` | Daily snapshots keep only the latest (a new one deletes the old). This prunes the hidden pre-restore safety snapshots older than this many days. |
| `BACKUP_TG_ENABLED` | `false` | Send a Telegram message when each day's snapshot is ready (or if it fails). Includes the Google Drive upload result when Drive is connected. |
| `GDRIVE_FOLDER_NAME` | `Trading Bot Backups` | Drive folder the snapshots are uploaded into (created on first upload). Only used once Google Drive is connected from Settings → Backup & Restore. |
| `GDRIVE_RETAIN` | `30` | Keep the newest N uploads in that Drive folder; older ones are deleted after each successful push. |
| `LIVE_HARNESS_DRY_RUN` | `true` | **Global** kill-switch, layer 1 of 3. When ON, *every* live order path (native `*Live` routes and every harness route) logs the broker call that *would* have been made and places no real order. Turning it OFF is not enough on its own: a strategy also needs its own `{STRATEGY}_LIVE_ENABLED=true` (layer 2) and must not have `{STRATEGY}_LIVE_DRY_RUN=true` (layer 3). All three are enforced in one place — [src/utils/liveDryRun.js](src/utils/liveDryRun.js) — so no live path can be armed by accident. Switch OFF only after verifying decisions match paper. |
| `HARNESS_EXCHANGE_SL_ENABLED` | `false` | **EXPERIMENTAL.** When on, each harness-live entry also leaves a resting **SL-M disaster stop** at the exchange, so a hard crash mid-position still has some protection (the primary stop is always the in-process per-tick stop). It's cancelled before any normal square-off. Places REAL resting orders — validate on a dry-run session first. Fails safe (skips the SL on any missing data / bad trigger). |
| `HARNESS_SL_PCT` | `0.5` | Disaster-stop distance as a fraction of entry premium: SL-M trigger = entryPremium × (1 − this). E.g. entry ₹120, `0.5` → trigger ₹60. Only used when `HARNESS_EXCHANGE_SL_ENABLED=true`. |
| `HARNESS_BROKER_TIMEOUT_MS` | `8000` | Timeout (ms) on every harness broker call (BUY/SELL/getPositions). A hung socket can't wedge an entry/exit forever; a timed-out **write** is surfaced (not retried, order may be live) so you verify manually. Min 1500. |
| `MAX_LOT_MULTIPLIER` | `10` | Safety ceiling on `LOT_MULTIPLIER`. A fat-finger `LOT_MULTIPLIER=50` is clamped to this so orders can't be silently sized 50×. |
| `EMA_RSI_ST_LIVE_DRY_RUN` | `false` | Per-strategy override — keeps EMA_RSI_ST in dry-run even when `LIVE_HARNESS_DRY_RUN=false`. Lets you take other strategies live while EMA_RSI_ST stays simulated (and vice-versa). |
| `ORB_LIVE_DRY_RUN` | `false` | Per-strategy override — keeps ORB in dry-run even when the global flag is off. |
| `PA_LIVE_DRY_RUN` | `false` | Per-strategy override — keeps the PA live harness in dry-run even when the global flag is off. |
| `BB_RSI_LIVE_DRY_RUN` | `false` | Per-strategy override — keeps BB_RSI in dry-run even when the global flag and `BB_RSI_LIVE_ENABLED` are both set for real orders. |
| `TREND_PB_LIVE_DRY_RUN` | `false` | Per-strategy override — keeps the Trend Pullback live harness in dry-run even when the global flag is off. |
| `BACKTEST_OPTION_SIM` | `true` | Legacy bar-based backtest only — Replay uses recorded option ticks |
| `BACKTEST_DELTA` / `BACKTEST_THETA_DAY` / `BACKTEST_SLIPPAGE_PTS` | `0.5` / `12` / `0` | Bar-based backtest inputs |

### UI Visibility Toggles
| Key | Default | Notes |
|-----|---------|-------|
| `UI_THEME` | `dark` | `dark`, `light`, or `auto` (light 06:00–18:00 IST, dark otherwise — resolved per page load) |
| `UI_SHOW_DASHBOARD` | `false` | When off, `/` redirects to Settings |
| `UI_SHOW_ALL_BACKTEST` | `true` | Top-level "Backtest" (unified) menu |
| `UI_SHOW_REALTIME` | `true` | Dashboard auto-swaps to Real-Time monitor while any session is running |
| `UI_DASHBOARD_ANALYTICS_PANEL` | `true` | Bottom analytics panel (live P&L during market hours; rolling stats after hours) |
| `UI_SHOW_REPLAY` | `true` | Top-level "Replay" menu (tick replay of recorded paper sessions) |
| `UI_SHOW_PAPER_HISTORY` / `UI_SHOW_LIVE_HISTORY` | `true` | Cross-mode history menus |
| `UI_SHOW_EDGE_ANALYTICS` | `true` | Top-level "Edge Analytics" menu (`/edge-analytics`) |
| `UI_SHOW_CONSOLIDATION_REPORT` | `true` | "📑 Consolidation Report" button on the Edge Analytics page → the daily consolidated report (`/consolidation-report`) |
| `UI_SHOW_ADVISOR` | `true` | Top-level "Settings Advisor" menu (`/advisor`) |
| `UI_SHOW_OI_MONITOR` | `false` | Top-level "OI Monitor" menu (`/oi-monitor`) — read-only per-strike OI ladder. Default **off**: it is a research instrument for an unbuilt strategy, not part of the daily trading flow. |
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
| `LOGIN_OTP_MOBILE` | — | Mobile number that can unlock a rate-limited login. On the locked-out page, typing this number sends a 6-digit OTP to Telegram (`POST /login/otp/send`); entering it (`POST /login/otp/verify`) clears that IP's lockout so the password can be retried without waiting for the countdown. Needs Telegram configured. Blank = feature off. Code valid 5 min, 5 sends + 5 wrong tries per lockout. |
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

### Settings Advisor (offline weekly trade-record review → `/advisor`)
| Key | Default | Notes |
|-----|---------|-------|
| `ADVISOR_LOOKBACK_DAYS` | `90` | How far back the review reads trades (clamped 7–3650) |
| `ADVISOR_MIN_TRADES` | `20` | A strategy below this many trades in the window gets no suggestions, only a "too few to tune" note (clamped 5–500). A bucket (exit reason / hour / weekday) needs 5 trades of its own — that floor is fixed in code |
| `ADVISOR_TELEGRAM` | `false` | Telegram the top findings every Sunday 08:00 IST. Also needs `TG_ENABLED` |

> The advisor is a **rules engine, not an LLM** — no network call, no API key, no cost, and it can only name env keys that exist. It is read-only: it never writes a setting, so acting on a finding stays a manual Settings save with the usual checkpoint note + audit trail. The weekly snapshot lands at `~/trading-data/.advisor_report.json` (idempotent per week, with boot catch-up after a redeploy); the page itself always recomputes live.

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

### 3M Gap Fix Scalp
| URL | Description |
|-----|-------------|
| `/gap-fix-3m-backtest` | 3M Gap Fix Scalp date-range backtest (front-month futures, rolled like the live path) |
| `/gap-fix-3m-paper/status` | Paper trade — NIFTY FUTURES chart with the gap band, day high/low and bracket, plus the index chart |
| `/gap-fix-3m-paper/history` | Sessions (per-session delete + view modal) |
| `/gap-fix-3m-live` | Live via the paper-wrapping harness (Fyers orders; gated by `GAP3M_LIVE_ENABLED` + `LIVE_HARNESS_DRY_RUN` + `GAP3M_LIVE_DRY_RUN`) |

### Analytics & Tools
| URL | Description |
|-----|-------------|
| `/realtime` | **Unified real-time monitor** — one screen for all enabled strategies with a PAPER/LIVE toggle. Cards for EMA_RSI_ST / BB_RSI / PA / ORB (each card is hidden when its `{STRATEGY}_MODE_ENABLED` is off) showing open position + today's stats, with a rollup table for **Today Total (Open + Closed)**. Read-only; polls each strategy's `/status/data` every 4s. Theme-aware. **Per-card Open Status + Copy Day Log buttons** (Copy Day Log copies raw entry + skip JSONL, not the human-readable summary). Copy Day Log needs the strategy to expose `/download/trades/:date` + `/download/skips/:date`; **ORB now does** (2026-08-04 — it always wrote both day files, it just never served them, so it alone showed "— No Day Log —"). Trend_PB still doesn't. |
| `/replay` | **Tick Replay** — deterministic re-run of a recorded paper session through the paper `onTick()` handlers. Single-date and date-range modes. Snapshot mode (session-start settings) vs current-settings mode (live `process.env`). Per-row diagnostic Replay buttons + downloadable diagnostic dump. Outputs land in `~/trading-data/_replay_trades/` (snapshot) or `_replay_trades_sim/` (current). |
| `/all-backtest` | **Unified backtest dashboard** — runs the same date range across all enabled strategies and renders the per-strategy stats side by side. **🧹 Clear Cache** sits next to Run on **every** backtest page (per-strategy pages included) and wipes the two historical-candle disk caches (`~/trading-data/backtest_cache` + `candle_cache`) so the next run re-downloads from Fyers — use it when a backtest looks like it ran on stale candles. It calls `POST /cache-files/clear-candles`: confirmed once, needs `API_SECRET`, and refused (409) while a backtest is running. Touches no trades and no settings. |
| `/consolidation` | Cross-mode **paper** trade history + analytics (EMA_RSI_ST + BB_RSI + PA, daily/monthly/yearly roll-ups, Day View panel, per-mode breakdown) |
| `/live-consolidation` | Cross-mode **live** trade history + analytics (parity with `/consolidation` for live data) |
| `/consolidation-report` | **Consolidation Report** — a **day-by-day** consolidated report (one table row per trading day), mirroring the Telegram "CONSOLIDATED DAY REPORT" layout: per-strategy trades + P&L columns, then Total / Wins / Losses / Win rate / Net P&L + a 🟢/🔴 result per day, with a totals footer. Book toggle (Paper / Live / **Both**) + a Range preset (**This week / Last week / This month / Last month / Last 7·30 days / This FY / All time / Custom**). Reached via the **📑 Consolidation Report** button on the Edge Analytics page (not a separate sidebar item). **🖨 Save as PDF** prints through a dedicated `@media print` stylesheet (app chrome hidden, white A4-landscape page, page-break-safe table) — the browser's native print-to-PDF; no external library. Reads the same session files as `/consolidation` + `/live-consolidation`; writes nothing. Gated by `UI_SHOW_CONSOLIDATION_REPORT`. |
| `/edge-analytics` | **Edge Analytics** — read-only edge dashboard over your recorded trades. Paper/Live book toggle + per-strategy + date-range (This month / Last month / Current week expiry / All / Custom — the same shared set as the Dashboard top bar) filters that recompute instantly client-side. **Headline cards** (trades, win rate, net P&L, expectancy, profit factor, avg win/loss + payoff, max drawdown, win/loss streaks) and a **risk-adjusted row** (Sharpe, Sortino, System Quality/SQN with its Van Tharp grade, recovery factor, Kelly size, edge confidence from a t-test on per-trade P&L, avg hold, cost drag) and an **edge-quality row** (expectancy in R, break-even win rate + the cushion above it, top-5 profit concentration, net excluding those five, equity-curve straightness/R², trades per day, worst run of consecutive red days) — the ratio cards show `—` with *need 10+ days* / *need 20+ trades* until the sample supports them. **Charts**: equity curve, daily P&L, underwater drawdown, P&L-by-hour, P&L-by-weekday, weekday × hour heatmap, monthly P&L grid, P&L distribution, R-multiple distribution, rolling 20-trade form, MFE/MAE heat scatter, and a 1,000-run bootstrap **Monte Carlo** (profitable-run %, median outcome, 1-in-20 bad run, expected max drawdown). **Tables**: By Strategy, By Exit Reason (worst first, to surface the bleed), Nth trade of the day, By Side, By Hold Time, By Signal Strength, By VIX at Entry, plus biggest winners & losers, and a **trade-efficiency** panel (capture %, ₹ left on the table, losers once green, median heat a winner survived). Responsive down to a phone: cards step 8 → 4 → 2 columns, charts shorten, tables and heat grids scroll inside their panel, and safe-area padding keeps the notch clear. Reads the same session files as `/consolidation` + `/live-consolidation`; writes nothing. Gated by `UI_SHOW_EDGE_ANALYTICS`. |
| `/oi-monitor` | **OI Monitor** — read-only live per-strike Open Interest ladder (ATM±N), with the **CE wall** (max-CE-OI strike = resistance) and **PE wall** (max-PE-OI strike = support), the wall band width, whether spot is inside it, and band PCR. ΔOI columns are percent change over the last 1 / 3 / 6 *actual OI moves* (not polls, not minutes — hover for the wall-clock span). Only strikes still inside the polled ATM±N band are shown or counted: the band moves with spot, and a strike it has drifted away from keeps its last OI forever, so an unfiltered ladder would report a morning strike as "the wall" on a trending afternoon. An observation log records, **but never trades**, two opposite readings: `DEFEND` (price pressing a wall whose OI is still rising → writers holding → the range-fade candidate) and `BREAK` (price at that wall while its OI falls → writers running → stand aside). Exists because per-strike OI cannot be backtested — Fyers has no historical-OI API — so the only way to research a range-day wall-fade is to record forward and review. Holds no position, places no order, owns no strategy state. Needs `OPTION_CHAIN_RECORD_OI`; gated by `UI_SHOW_OI_MONITOR` (default off). |
| `/advisor` | **Settings Advisor** — offline weekly review of your own trade record that names the Settings key to look at. No external service, no API key, no cost: a deterministic rules engine (not an LLM) over the same trade set `/edge-analytics` renders. Checks profit factor, the worst exit-reason bucket, losing entry hours, CE/PE skew, weekday drag, worst day vs the daily-loss cap, intraday loss runs vs the streak brake, and winner-vs-loser holding time. Every finding is sample-gated (a strategy needs `ADVISOR_MIN_TRADES`, a bucket needs 5 trades) and carries the real env keys involved. **Suggests only — never writes a setting.** Book (Paper/Live) + window filters; a weekly snapshot is taken Sunday 08:00 IST to `~/trading-data/.advisor_report.json`. Gated by `UI_SHOW_ADVISOR`. |
| `/pnl-history` | Broker-wise realised P&L (one-time past baselines per broker + auto-computed live-bot P&L by FY) |
| `/compare/trading` | Paper vs Backtest comparison (EMA_RSI_ST) |
| `/compare/bb_rsi` | Paper vs Backtest comparison (bb_rsi) |
| `/settings` | All config settings UI + Bulk Edit modal (paste/delete keys) + **checkpoint note prompt on every save** + server restart. Saved notes are appended to that day's trade JSONL alongside a settings snapshot, so the daily log carries the exact config that produced its trades. Hosts the `POST /settings/reset-data` endpoint used by the **Reset Data** dialog on the Logs page. |
| `/trade-logs` | **Renamed from JSONL viewer in v4.5.0.** Per-mode trade-log file manager: per-day trade entries + cumulative skip logs in a separate tab. Top bar has a **🧹 Reset Data** button: a category picker (Paper trade history / Skip trade history / Cache / Logs / Ticks data) with a **select-all** and an optional **date range** — the range deletes matching per-day files (paper/skip daily JSONL + tick day-folders); Cache & Logs always clear fully. Checking **Paper** with **no** date range also fans out to the per-strategy `/reset` routes to restore starting capital + wipe sessions for all 5 strategies (a running strategy is skipped). Posts to `POST /settings/reset-data`. The **Trade Files** and **Skip Logs** tabs each show **one strategy at a time**, picked from a sticky strategy chip bar (each chip carries that strategy's file count; an **All** chip stacks every strategy on one page as before). The pick is remembered per tab; counts come from `GET /trade-logs/counts`. Per-mode **Download All** + **Delete All** buttons, plus a single **Download Everything (all strategies)** button on both the Trade Files and Skip Logs tabs (`/trade-logs/download-everything` and `/trade-logs/skips/download-everything`) that concatenates every mode's daily files into one self-describing JSONL (each line carries its own `mode`). JSONL is the canonical export format (CSV/PDF dropped — they were drifting on edge cases). The **Checkpoints & Settings Changes** tab now has a per-row **↩ Restore** button that reverts a key to its prior value (with a "restore all keys with the same note" checkbox when the entry has a note, and a one-click restart prompt when needed). Light-theme aware. |
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
- **Indicators**: `technicalindicators` (EMA, RSI, ADX, ATR, Bollinger Bands) + SuperTrend from [src/utils/supertrend.js](src/utils/supertrend.js). **Parabolic SAR is no longer computed anywhere** — stripped from EMA_RSI_ST 2026-06-12 and from BB_RSI 2026-07-05; only filenames and comments still carry the name.
- **Brokers**: Zerodha Kite Connect (EMA_RSI_ST live) + Fyers API v3 (bb_rsi + PA live + all data)
- **Notifications**: Telegram Bot API with 17 per-mode toggles + master gate + consolidated EOD
- **Charts**: Chart.js (theme-aware) + live candlestick overlays on status pages
- **Deployment**: PM2 on AWS EC2 t3.micro + GitHub Actions CI/CD
- **Caching**: Disk-based candle cache (backtest + live, auto-pruned)
- **Compression**: gzip middleware on all HTTP responses (≈80% size reduction on `/settings`; ~329 KB → 61 KB)

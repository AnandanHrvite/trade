# Palani Andawar Trading Bot

NIFTY options algorithmic trading bot with **5 independent strategies** (Swing, Scalp, Price Action, ORB, Straddle), dual-broker architecture (Fyers + Zerodha), background backtesting, paper trading, deterministic **tick-replay** of recorded sessions, after-hours simulation, live NIFTY candlestick charts, consolidated cross-mode analytics (paper + live), per-module dashboard P&L cards, **unified real-time monitor** (one screen for all strategies with a PAPER/LIVE toggle), crash-safe JSONL trade audit, near-miss filter audit, Telegram alerts, and a full web dashboard.

## Architecture

```
Fyers WebSocket (NIFTY50 spot ticks — single connection)
        │
   socketManager (singleton, multi-callback fan-out)
        │
   ┌─────┼──────────────┬──────────────┬───────────┬─────────────┐
   │     │              │              │           │             │
 Swing (5/15-min)   Scalp (3/5-min)   Price Action   ORB           Straddle
   │                    │                │           │             │
 ┌─┴─┐               ┌──┴──┐         ┌───┴──┐    ┌──┴──┐       ┌───┴──┐
 │   │               │     │         │      │    │     │       │      │
Live  Paper         Live  Paper     Live   Paper Live Paper   Live   Paper
Zerodha  Sim        Fyers  Sim      Fyers   Sim  Fyers  Sim   Fyers   Sim
```

All five strategies run **in parallel** on the same WebSocket — different candle resolutions, different brokers, independent risk controls. Within each strategy, Live ⊥ Paper (mutually exclusive); across strategies everything coexists.

## Modes

| Mode | Strategy | Timeframe | Broker | Route Prefix |
|------|----------|-----------|--------|-------------|
| **Swing Live** | EMA 20/50 (+9 opt) + RSI + SuperTrend | 3 / 5 / 15-min via `TRADE_RESOLUTION` | Zerodha | `/swing-live` |
| **Swing Paper** | EMA 20/50 (+9 opt) + RSI + SuperTrend | 3 / 5 / 15-min via `TRADE_RESOLUTION` | Simulated | `/swing-paper` |
| **Swing Backtest** | EMA 20/50 (+9 opt) + RSI + SuperTrend | 3 / 5 / 15-min via `TRADE_RESOLUTION` | Historical | `/swing-backtest` |
| **Scalp Live** | BB + PSAR + RSI (V5) | 3 / 5-min | Fyers | `/scalp-live` |
| **Scalp Paper** | BB + PSAR + RSI (V5) | 3 / 5-min | Simulated | `/scalp-paper` |
| **Scalp Backtest** | BB + PSAR + RSI (V5) | 3 / 5-min | Historical | `/scalp-backtest` |
| **PA Live (legacy)** | Price Action Patterns | 5-min | Fyers | `/pa-live` |
| **PA Live (Harness)** | Price Action Patterns | 5-min | Fyers (PAPER-wrapped) | `/pa-live-harness` |
| **PA Paper** | Price Action Patterns | 5-min | Simulated | `/pa-paper` |
| **PA Backtest** | Price Action Patterns | 5-min | Historical | `/pa-backtest` |
| **PA Pattern Backtest** | Per-pattern attribution | 5-min | Historical | `/pa-pattern-backtest` |
| **ORB Live** | Opening Range Breakout (single-leg CE/PE) | 1-min ticks on a 15-min OR | Fyers | `/orb-live` |
| **ORB Paper** | Opening Range Breakout | 1-min ticks on a 15-min OR | Simulated | `/orb-paper` |
| **ORB Backtest** | Opening Range Breakout | 1-min historical | Historical | `/orb-backtest` |
| **Straddle Live** | Long Straddle (paired CE+PE) | BB-squeeze on 5-min | Fyers (paired) | `/straddle-live` |
| **Straddle Paper** | Long Straddle | BB-squeeze on 5-min | Simulated | `/straddle-paper` |
| **Straddle Backtest** | Long Straddle | 5-min historical | Historical | `/straddle-backtest` |
| **Replay** | Re-runs a recorded paper session through the paper `onTick()` | Recorded ticks | Recorded | `/replay` |
| **All Backtest** | Unified backtest dashboard (per-strategy stats) | Per-strategy | Historical | `/all-backtest` |
| **Manual Tracker** | — (trails SL only) | 15-min | Zerodha | `/tracker` |
| **Simulation** | Any (after-hours) | Configurable | Simulated ticks | `/*/simulate` |

> **PA Live (Harness)** runs Live by wrapping the Paper engine and forwarding decisions to a broker harness, so Live = Paper by construction. The legacy `/pa-live` is preserved during the data-collection window for parity comparison.

### Parallel Compatibility

Within each strategy, Live ⊥ Paper (mutual exclusion). Across strategies, every combination is allowed — Swing, Scalp, PA, ORB, Straddle can run together (paper or live) on the same Fyers socket via [sharedSocketState](src/utils/sharedSocketState.js). Backtests run in a background queue (one at a time) and never block live/paper modes.

The dashboard has **Start-All Paper** and **Start-All Live** buttons that start every enabled mode in sequence with a single click; the two are **mutually locked** (one disables the other and pulses while active) so you never accidentally double-run paper + live across modes. Start-all failures surface in a modal instead of silently reloading.

### Dashboard Layout

- **Per-module cards** (Swing / Scalp / PA) — each card has its own Paper/Live toggle, trades, win-rate, total-P&L, and a cumulative P&L chart. Charts colour green/red by P&L sign.
- **Cumulative P&L card** with a Paper/Live toggle that swaps the data source feeding the per-module charts.
- **Side-by-side broker rows** (Fyers + Zerodha on one row).
- **Hover-only date labels** on charts (x-axis decluttered).
- **Sync to Local button** — one click streams `~/trading-data/` as a `tar.gz` to the browser (server → client only). Lets you mirror the EC2 host's persistent data without SSH.

## Strategies

### Strategy 1: Swing — EMA 20/50 (+9 opt) + RSI + SuperTrend (entry redefined 2026-05-31; PSAR stripped 2026-06-12; 3 / 5 / 15-min via env)
- **Entry (intra-candle, all 3 true)**:
  - **CE**: EMA alignment bullish — 2-EMA (default) EMA20 **above** EMA50, or triple-stack (`SWING_EMA_TRIPLE_STACK_ENABLED`) EMA9 > EMA20 > EMA50 (`SWING_EMA_FASTEST`/`SWING_EMA_FAST`/`SWING_EMA_SLOW`) · RSI(14) `> RSI_CE_MIN` and `< RSI_CE_MAX` (overbought guard) · **SuperTrend bullish**.
  - **PE**: mirror — EMA20 **below** EMA50 (or EMA9 < EMA20 < EMA50) · RSI `< RSI_PE_MAX` and `> RSI_PE_MIN` (oversold guard) · **SuperTrend bearish**.
- **Initial SL** (unchanged): previous completed candle's **low (CE) / high (PE)** — used as-is (no hybrid cap). `EMA21(OHLC4)` is computed for the SL trail + trade-record snapshot, not an entry input.
- **Trailing**: each candle close, tighten SL to **EMA21** — tighten-only; an EMA21 touch-back is an explicit exit.
- **Exits**: EMA21 trail / EMA touch-back, optional N-bar candle trail (`SWING_CANDLE_TRAIL_ENABLED`, tighter-of) · **negative-candle stop** (`SWING_NEG_CANDLE_LIMIT`, default 2 — square off a trade still in the red after N candles) · per-trade points stop (`SWING_STOP_LOSS_PTS`, off by default) · option-premium stop (`OPT_STOP_PCT`) · opposite signal · exit-before-close (`SWING_EOD_EXIT_TIME`) · EOD auto-stop (`TRADE_STOP_TIME`). Choppy-day guard: halt entries after `SWING_MAX_CONSEC_LOSSES` consecutive losers (off by default).
- **Same-side cooldown**: after an SL / option-stop hit, block that side for `SWING_SL_PAUSE_CANDLES` candles.
- **Opposite-side (flip) cooldown**: after any non-flip exit, block the OPPOSITE side for `SWING_OPPOSITE_SIDE_COOLDOWN_CANDLES` candles (toggle: `SWING_OPPOSITE_SIDE_COOLDOWN_ENABLED`). Prevents whipsaw flips on chop. Opposite-signal / EOD / manual exits do not trigger it.
- **Guards kept**: VIX gate, `MAX_DAILY_LOSS`, `MAX_DAILY_TRADES`, trading window, expiry-day-only, Swing expiry override/type.
- **Removed**: **Parabolic SAR** — fully stripped 2026-06-12 (SuperTrend is the only trend source; EMA21 the only SL). The `SWING_USE_SUPERTREND` toggle and the `SWING_SL_MODE=psar` option are gone. Earlier removals: EMA21-price-touch entry gate + `SWING_ENTRY_REQUIRE_CROSS` / `_CROSS_TOLERANCE`; EMA30 trend gate, ADX, candle-body, SAR-distance, Logic-3 overrides, STRONG/MARGINAL strength tiers, tiered (T1/T2/T3) trail, hybrid initial-SL cap, 50% candle rule.
- **Chart**: EMA20 (gold) + EMA50 (blue) lines, SuperTrend line (green bullish / red bearish), RSI subplot. EMA values + trend source are recorded per trade in the JSON + daily JSONL (`ema9AtEntry`/`ema20AtEntry`/`ema50AtEntry` + `*AtExit`; `ema9*` populated only when the triple-stack is ON).
- **Resolution-agnostic**: same rules on 3 / 5 / 15-min — set `TRADE_RESOLUTION` in `.env` (or via Settings).

### Strategy 2: Scalp — BB + PSAR + RSI V6.1 (3 / 5-min)
See [SCALP.md](SCALP.md) for the authoritative spec. Summary:
- **Entry (at candle close, all required)** — **CE**: close ≥ BB upper **and** PSAR below close **and** RSI in band `SCALP_RSI_CE_MIN(52)` < RSI < `SCALP_RSI_CE_MAX(70)`. **PE**: close ≤ BB lower **and** PSAR above close **and** RSI in band `SCALP_RSI_PE_MIN(30)` < RSI < `SCALP_RSI_PE_MAX(49)`. RSI is a **band**: the upper cap (CE) / lower floor (PE) skips overbought/oversold extremes where the breakout typically reverses. **Far-PSAR filter**: skip if PSAR is more than `SCALP_MAX_ENTRY_SL_PTS(50)` pts from close (avoids uncapped-risk entries). **ADX trend filter** (optional, `SCALP_ADX_ENABLED`): block all entries when ADX(14) < `SCALP_ADX_MIN(20)` — sits out choppy/ranging sessions where the strategy bleeds.
- **Guards**: optional `SCALP_RSI_TURNING`, independent VIX filter.
- **Indicators**: Bollinger Bands `20 / 1` (std-dev **1**), RSI(14), PSAR `0.02 / 0.2`.
- **Initial SL** = PSAR value at entry (no clamp). Used for risk sizing + display; it is **not** an intra-tick stop and does not trail.
- **Exit** (per-tick, **spot points**): **Profit lock** — once peak favourable spot move ≥ `SCALP_PROFIT_LOCK_TRIGGER_PTS(25)`, exit when it gives back below `SCALP_PROFIT_LOCK_PCT(50)`% of peak (ratchets up: peak 100pts → lock 50pts); the upside exit. → **Hard stop** — exit if the trade moves ≥ `SCALP_STOP_LOSS_PTS(30)` against entry; a **wide** catastrophic loss cap that only clips deep adverse excursions on failed fades (the shown PSAR SL is display/sizing only). Both points-based so they work even on spot-proxy sessions. → **BB re-entry** (per-tick): exit the instant spot crosses back through the band (failed breakout), at the band line — not the bar close (`SCALP_BB_REENTRY_EXIT`, default on); armed only once the breakout has extended ≥ `SCALP_BB_REENTRY_ARM_PTS(10)` past the band, so a fresh entry sitting right at the band isn't knocked out by an immediate noise wick → **PSAR flip** on candle close handles trend runners → bid-ask spread guard → EOD. No break-even-to-entry snap, no PSAR/prev-candle SL trail, no % spot-trail, no time-stop.
- **Per-side SL pause** (`SCALP_PER_SIDE_PAUSE`): an SL on CE only pauses CE entries; PE remains free, plus `SCALP_CONSEC_SL_EXTRA_PAUSE` extra candles per consecutive SL.
- **Per-trade context logging** (additive): each trade record captures BB / RSI / trend context at entry and **MFE / MAE** (max-favorable + max-adverse excursion in pts and ₹) over the life of the trade, **`secsToMFE` / `secsToMAE`** (seconds from entry to that peak / trough — distinguishes early-peak-then-giveback from slow-grind, for trail tuning), plus **`vixAtExit`** — feeds the active paper-trade data-collection schema. This enrichment is now uniform across all 5 strategies (paper + live): each logs the signal diagnostics it computes at entry (Swing: EMA9/slope/RSI/SAR/ADX; PA: RSI/ADX/trend/pattern/SR; ORB: VWAP-aligned/vol/wick pass flags; Straddle: trigger/BB-width + combined-premium MFE/MAE + max spot travel) so post-window analysis can correlate behaviour with market conditions. Timing fields use each engine's replay-safe tick clock so replayed sessions reproduce identical values

### Strategy 3: Price Action — Chart-Pattern Breakouts (5-min)
- **Patterns (the only four entry logics)**:
  - **Double Bottom (W) → CE** — twin equal swing lows + close above the neckline (peak between them)
  - **Double Top (M) → PE** — twin equal swing highs + close below the neckline (valley between them)
  - **Ascending Triangle → CE** — flat resistance (equal swing highs) + rising swing lows, close above resistance
  - **Descending Triangle → PE** — flat support (equal swing lows) + falling swing highs, close below support
  - "Equal" levels are within `PA_CHART_PATTERN_TOL=12` pts; the breakout candle body must be ≥ `PA_MIN_BODY=5` pts. The old Engulfing / Pin Bar / Inside Bar / BOS patterns were removed.
- **Swings**: last `PA_SR_LOOKBACK=30` candles drive both detection and the structure trail.
- **No RSI / ADX confluence** — pure chart-pattern entries (the breakout candle is the signal). The only entry gate beyond the pattern is the `PA_MIN_BODY` breakout-candle-body check.
- **SL (pattern structure)**: placed `PA_SL_BUFFER_PTS=3` beyond the pattern extreme — below the twin bottoms / rising-low support (CE), above the twin tops / falling-high resistance (PE) — then clamped to `[PA_MIN_SL_PTS=8, PA_MAX_SL_PTS=25]`.
- **Exit — breakeven then swing trail**: once peak PnL ≥ `PA_BREAKEVEN_TRIGGER=300` (₹), the SL lifts to entry ± `PA_BREAKEVEN_BUFFER=1` pts (a winner can't round-trip to a loss); from there the structure trail tightens the SL to each new swing low (CE) / swing high (PE). Bid-ask spread guard + EOD square-off still apply. The old candle-trail / tiered profit-lock / time-stop were removed.

### Strategy 4: ORB — Opening Range Breakout (15-min OR, single-leg CE/PE)
- **Opening range**: high/low of the configured window (`ORB_RANGE_START=09:15` → `ORB_RANGE_END=09:30` by default). After `ORB_RANGE_END`, a long CE is taken on a breakout above ORH or a long PE on a breakdown below ORL.
- **Entry filters** (all toggleable):
  - Range width `[ORB_MIN_RANGE_PTS=25, ORB_MAX_RANGE_PTS=120]` — skips tight noise and exhausted gaps.
  - Breakout body ≥ `ORB_MIN_BODY=8` pts.
  - **Wick rejection** (`ORB_WICK_FILTER_ENABLED`): opposing wick ≤ `ORB_MAX_WICK_RATIO=0.6` × body.
  - **VWAP alignment** (`ORB_VWAP_FILTER_ENABLED`): CE only above session VWAP, PE only below. Falls back to TWAP when candles carry no volume.
  - **Volume confirmation** (`ORB_VOL_FILTER_ENABLED`): breakout volume ≥ `ORB_VOL_MULT=1.2` × prior `ORB_VOL_LOOKBACK=5` candle avg. Auto-skipped on volumeless indices.
  - **Premium-range gate** (`ORB_PREMIUM_GATE_ENABLED`): ATM LTP must sit inside `[ORB_PREMIUM_MIN=80, ORB_PREMIUM_MAX=250]` to filter out deep-OTM lottery tickets and ITM-acting-like-futures.
  - **Sweet-spot tiering** (`ORB_SWEET_MIN=30` / `ORB_SWEET_MAX=80` / `ORB_STRONG_BODY=15`): outside sweet spot = MARGINAL (still allowed); inside + breakout body ≥ strong-body = STRONG.
  - **VIX gate**: `ORB_VIX_ENABLED` + `ORB_VIX_MAX_ENTRY=22` / `ORB_VIX_STRONG_ONLY=18`.
  - **Expiry-day-only** (`ORB_EXPIRY_DAY_ONLY`): block ORB on non-expiry sessions when set.
- **Stop / exit — single candle-structure trailing stop** (`ORB_SL_CANDLES=2`): the SL is the swing of the last N closed candles — CE → lowest low, PE → highest high — recomputed on every candle close and ratcheted in the favourable direction only (never loosens). The same level is both the initial stop and the trail, so a winner rides until structure breaks. This is the **only** stop: the old premium −%/spot-edge stops, move-to-breakeven, premium lock-in, continuous-premium trail and the fixed profit target were all removed. (`ORB_TARGET_RANGE_MULT` is retained only as an informational target line on the chart.)
- **Risk caps**: 1 trade/day default (`ORB_MAX_DAILY_TRADES=1`), `ORB_MAX_DAILY_LOSS=3000`, forced square-off at `ORB_FORCED_EXIT=15:15` (the only non-stop exit), last entry `ORB_ENTRY_END=12:00` (stale-breakout cutoff).

### Strategy 5: Straddle — Long Straddle (paired CE+PE, volatility expansion)
- **Trigger**: BB-squeeze on 5-min — current BB width ≤ `STRADDLE_SQUEEZE_RATIO=0.85` × the `STRADDLE_BB_AVG_LOOKBACK=20`-bar average.
- **Entries** are paired: CE and PE legs at ATM placed sequentially. Live partial-fill protection: if PE fails after CE fills, the engine sends a Telegram alert (no auto-unwind).
- **Cheap-premium path** (`STRADDLE_VIX_CHEAP=14`): when VIX is below this floor, the squeeze trigger fires more readily because premiums are cheap — the typical reason to long a straddle.
- **Force-next-entry override** (`STRADDLE_FORCE_ENTRY_NEXT`): one-shot flag that bypasses BB/VIX gates on the next candle close. Auto-resets after firing. Use for RBI/budget/results event days.
- **Exit**: combined-premium target `STRADDLE_TARGET_PCT=0.20` (net debit + 20% — locks the rare gamma pop intraday) and SL `STRADDLE_STOP_PCT=0.30` (net debit − 30% — wider SL absorbs intraday noise). Max hold `STRADDLE_MAX_HOLD_DAYS=0.3` (intraday only). Forced square-off `STRADDLE_FORCED_EXIT=15:15`.
- **Risk caps**: 1 pair/day (`STRADDLE_MAX_DAILY_PAIRS`), `STRADDLE_MAX_DAILY_LOSS=3000`, entry window `STRADDLE_ENTRY_START=09:30` → `STRADDLE_ENTRY_END=11:00` (late straddles bleed theta).
- **VIX gate**: `STRADDLE_VIX_ENABLED=true` by default, `STRADDLE_VIX_MAX_ENTRY=22` blocks pumped-premium days, `STRADDLE_VIX_STRONG_ONLY=18`.

### Tick Replay — deterministic re-run of recorded sessions
- Every paper/live session records spot, option, and VIX ticks to `~/trading-data/ticks/YYYY-MM-DD/*.jsonl` when `TICK_RECORDER_ENABLED=true` (default; pure observer, no trade-path impact). Retention: `TICK_RECORDER_RETAIN_DAYS=30`.
- `/replay` re-runs a recorded session through the same paper `onTick()` handlers to produce **bit-identical** results.
- Two modes: **Snapshot mode** uses the session-start settings snapshot from that day's JSONL → identical output every run; **Current-settings mode** uses the live `process.env` so you can A/B settings changes against real ticks after hours.
- Outputs land in `~/trading-data/_replay_trades/` (snapshot) or `_replay_trades_sim/` (current-settings) — kept separate from the canonical paper logs.
- Date-range replays loop per session and render a per-row table with one-click re-runs.

### Market Scenario Simulator
- After-hours testing with 8 scenarios: trending up/down, choppy, volatile, breakout up/down, V-recovery, inverted-V
- Each generates ~75 candles simulating a full 9:15–15:30 session
- Runs the production `onTick()` pipeline — same SL, trailing, exit logic as live
- Historical date replay with 1-min candle tick replay (300-candle warmup for swing/PA)
- Zigzag intra-candle tick noise (not smooth O→H→L→C arc) for realistic fills
- Available for all 3 strategy modes

### Live NIFTY Chart Overlay
- Live candlestick chart on all paper + live status pages (toggleable via `CHART_ENABLED`)
- **Entry logic overlays**: Bollinger Bands on scalp charts, swing points on PA charts
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
  paper_trades.json               # Swing paper trade sessions
  live_trades.json                # Swing live trade sessions
  scalp_paper_trades.json         # Scalp paper sessions
  scalp_live_trades.json          # Scalp live sessions
  pa_paper_trades.json            # Price action paper sessions
  pa_live_trades.json             # Price action live sessions
  orb_paper_trades.json           # ORB paper sessions
  orb_live_trades.json            # ORB live sessions
  straddle_paper_trades.json      # Straddle paper sessions (paired CE+PE)
  straddle_live_trades.json       # Straddle live sessions
  historical_pnl.json             # One-time P&L baselines per broker (Kite / Fyers)
  .active_trade_position.json     # Crash recovery — swing position
  .active_scalp_position.json     # Crash recovery — scalp position
  .active_pa_position.json        # Crash recovery — PA position
  .harness_events.json            # Live-harness event log (DRY-RUN/real order events), survives restart
  swing_paper_trades_log.jsonl    # Crash-safe per-trade JSONL audit (cumulative)
  scalp_paper_trades_log.jsonl
  pa_paper_trades_log.jsonl
  orb_paper_trades_log.jsonl
  straddle_paper_trades_log.jsonl
  trades/                         # Per-day JSONL files: {mode}_paper_trades_YYYY-MM-DD.jsonl
                                  # (one file per strategy per day; seeded with a settings snapshot
                                  #  + checkpoint note, re-snapshotted on every config save)
  ticks/YYYY-MM-DD/               # Replay source: per-day spot / option / VIX tick recordings
                                  # (gated by TICK_RECORDER_ENABLED; retention TICK_RECORDER_RETAIN_DAYS)
  _replay_trades/                 # Replay output — snapshot mode (uses session-start settings)
  _replay_trades_sim/             # Replay output — current-settings mode (uses live process.env)
  backtest_cache/                 # Cached historical candles (90-day auto-prune)
  candle_cache/                   # Live candle cache (60-day trim)
  reports/                        # Daily trade reports
```

> ORB and Straddle do not yet have `.active_orb_position.json` / `.active_straddle_position.json` crash-recovery files — orphan-position reconciliation on boot covers Swing/Scalp/PA only. Add to `positionPersist.js` if/when these strategies need restart-survival of an open position.

## Key .env Settings

### Swing Strategy (EMA 20/50 (+9 opt) + RSI + SuperTrend, Zerodha)
**Entry redefined 2026-05-31; PSAR stripped 2026-06-12.** Entry (intra-candle, all 3 true): **CE** = EMA alignment bullish (2-EMA default: EMA20 above EMA50; or triple-stack `SWING_EMA_TRIPLE_STACK_ENABLED`: EMA9 > EMA20 > EMA50 via `SWING_EMA_FASTEST`/`SWING_EMA_FAST`/`SWING_EMA_SLOW`), RSI(14) `> RSI_CE_MIN` and `< RSI_CE_MAX`, **SuperTrend bullish**. **PE** = mirror (EMA20 below EMA50 / EMA9 < EMA20 < EMA50, RSI `< RSI_PE_MAX` and `> RSI_PE_MIN`, **SuperTrend bearish**). **Stop** = initial SL is the previous candle low (CE) / high (PE) from `getSignal`, then trailed by **EMA21** (EMA touch-back is an explicit exit), tighten-only. Optionally layer an **N-bar candle trail** (`SWING_CANDLE_TRAIL_ENABLED` / `SWING_CANDLE_TRAIL_BARS`, default 3 bars): each candle close the stop is set to whichever is tighter — the EMA21 line or the N-bar low/high. **Exits**: trail SL · **negative-candle stop** (`SWING_NEG_CANDLE_LIMIT`, default 2 — still red after N candles → square off; winners keep riding the trail) · per-trade points stop (`SWING_STOP_LOSS_PTS`, off by default) · EMA21 touch-back · option stop (`OPT_STOP_PCT`) · opposite signal · exit-before-close (`SWING_EOD_EXIT_TIME`) · EOD auto-stop. Same-side cooldown after an SL hit (`SWING_SL_PAUSE_CANDLES`). **Choppy-day guard** (`SWING_MAX_CONSEC_LOSSES`, off by default): after N consecutive losing trades in a session, halt new entries for the rest of the day — any winner resets the streak. _Parabolic SAR fully removed 2026-06-12 (SuperTrend is the only trend source; EMA21 the only SL); breakeven removed 2026-06-02._

| Key | Default | Notes |
|-----|---------|-------|
| `TRADE_RESOLUTION` | `5` | Candle size in minutes — `3`, `5`, or `15` (logic is resolution-agnostic). |
| `MAX_DAILY_LOSS` | `5000` | Daily kill-switch in INR |
| `MAX_DAILY_TRADES` | `6` | Daily entry cap — anti-overtrade on chop days |
| `SWING_LIVE_ENABLED` | `false` | Must be `true` AND `LIVE_HARNESS_DRY_RUN=false` for real Zerodha orders. When `LIVE_HARNESS_DRY_RUN=true` (default), Swing Live logs the broker calls it would make (entry, hard-SL, trail, exit) but places none. |
| `BACKTEST_OPTION_SIM` | `true` | Realistic option P&L (delta x theta) |
| `RSI_CE_MIN` | `52` | CE entry: RSI(14) must be above this (bullish momentum floor) |
| `RSI_CE_MAX` | `80` | CE blocked when RSI at/above this (overbought guard) |
| `RSI_PE_MAX` | `48` | PE entry: RSI(14) must be below this (bearish momentum cap) |
| `RSI_PE_MIN` | `20` | PE blocked when RSI at/below this (oversold guard) |
| `SWING_EMA_FAST` | `20` | Fast/mid EMA period (close). 2-EMA mode: CE needs EMA-fast above EMA-slow; PE below. Triple-stack: this is the MID EMA. |
| `SWING_EMA_SLOW` | `50` | Slow EMA period (close). The EMA-fast vs EMA-slow alignment is the directional entry gate. |
| `SWING_EMA_TRIPLE_STACK_ENABLED` | `false` | Stricter EMA gate. `false` = 2-EMA cross. `true` = require EMA-fastest > EMA-mid > EMA-slow (CE) / reverse (PE) — the fast EMA must confirm too. Cuts marginal cross-over chop entries (skip logs show it blocks flat-EMA bars the 2-EMA gate would take). A/B via `/replay` before enabling live. |
| `SWING_EMA_FASTEST` | `9` | Fastest EMA period (close) in the 9>20>50 stack. Only used when `SWING_EMA_TRIPLE_STACK_ENABLED=true`. |
| `OPT_STOP_PCT` | `0.25` | Exit if option premium drops this fraction below entry premium (0.25 = 25%) |
| `SWING_NEG_CANDLE_LIMIT` | `2` | Negative-candle stop — if a trade is still in the red (option premium below entry) at the close of this many candles, square it off. Asymmetric loss-cut: winners keep riding the EMA trail; losers don't bleed across the chop. `0` = disabled. |
| `SWING_STOP_LOSS_PTS` | `0` | Per-trade catastrophic loss cap — exit if spot moves this many points against entry. Checked before the structural/trail SL, so it caps deep adverse excursions when the prevHigh/prevLow stop sits wider than the cap. Points-based (mirrors `SCALP_STOP_LOSS_PTS`). `0` = disabled. |
| `SWING_MAX_CONSEC_LOSSES` | `0` | Choppy-day guard — after this many **consecutive losing trades** in a session, halt new Swing entries for the rest of the day; any winning trade resets the streak. Sits out range days that bleed small stops instead of repeatedly re-entering. Independent of the legacy 3-loss escalating pause. `0` = disabled. |
| `SWING_CANDLE_TRAIL_ENABLED` | `false` | Layer an N-bar candle trail on top of the EMA21 SL. Each candle close the stop is set to whichever is **tighter** (closer to price) — the EMA21 line or the N-bar low (CE) / high (PE). Banks more of a winner; never loosens. |
| `SWING_CANDLE_TRAIL_BARS` | `3` | Lookback for the candle trail: lowest low (CE) / highest high (PE) of the last N candles. `1` = tightest; higher = looser (gives winners room, fewer chop stop-outs). Only used when `SWING_CANDLE_TRAIL_ENABLED=true`. |
| `SWING_SUPERTREND_PERIOD` / `SWING_SUPERTREND_MULT` | `10` / `3` | SuperTrend ATR period + multiplier — SuperTrend is the entry directional gate. |
| `SWING_SL_PAUSE_CANDLES` | `3` | After an SL / option-stop hit on a side, block that side for N candles (0 = off) |
| `SWING_OPPOSITE_SIDE_COOLDOWN_ENABLED` | `true` | When `true`, after any non-flip exit (SL / trail SL / option-stop / EMA touch-back) block entries on the OPPOSITE side for N candles. Prevents whipsaw flips on chop. Opposite-signal / EOD / manual exits do not trigger the cooldown. |
| `SWING_OPPOSITE_SIDE_COOLDOWN_CANDLES` | `3` | Opposite-side cooldown duration in candles (× `TRADE_RESOLUTION` → minutes; e.g. 3 candles × 5-min = 15 min). |
| `SWING_EOD_EXIT_TIME` | `15:15` | Square off any open position at/after this IST time, ahead of the market-close auto-stop |
| `VIX_FILTER_ENABLED` / `VIX_MAX_ENTRY` | `false` / `20` | Block entries above this VIX (Swing-scoped) |
| `TRADE_ENTRY_START` | `09:30` | Earliest entry time (IST) |
| `TRADE_ENTRY_END` | `14:00` | Latest entry time (IST) |
| `TRADE_EXPIRY_DAY_ONLY` | `false` | Only trade on NIFTY expiry day |
| `SWING_OPTION_EXPIRY_OVERRIDE` | (blank) | Swing-only expiry override — keep swing on next-week expiry while scalp/PA trade current. Blank inherits the common expiry. |
| `SWING_OPTION_EXPIRY_TYPE` | (blank) | Swing-only expiry type (`weekly`/`monthly`) for the override above. Blank inherits the common `OPTION_EXPIRY_TYPE`. |
| (auto) | — | Swing `/start` is **blocked** when configured expiry == today (0DTE refusal — gamma risk on holding swing through expiry). |

> Common expiry knobs (`OPTION_EXPIRY_OVERRIDE`, `OPTION_EXPIRY_TYPE`) live under **Common — Instrument & Backtest** in Settings and are read by `src/config/instrument.js` for every engine that does not set its own per-mode override.

### Scalp Mode (3 / 5-min, Fyers)
Full spec: [SCALP.md](SCALP.md).
| Key | Default | Notes |
|-----|---------|-------|
| `SCALP_MODE_ENABLED` | `true` | Show/hide scalp menus in sidebar (also hides Scalp section in Settings) |
| `SCALP_ENABLED` | `false` | Must be `true` for Fyers scalp orders |
| `SCALP_RESOLUTION` | `5` | Scalp candle size — `3` or `5` min |
| `SCALP_BB_PERIOD` / `SCALP_BB_STDDEV` | `20` / `1` | Bollinger inputs (std-dev **1** — tighter than the charting default of 2) |
| `SCALP_RSI_CE_MIN` | `52` | CE entry: RSI must be above this (bullish momentum floor) |
| `SCALP_RSI_CE_MAX` | `70` | CE entry blocked at/above this (skip overbought breakouts that reverse) |
| `SCALP_RSI_PE_MAX` | `49` | PE entry: RSI must be below this (bearish momentum cap) |
| `SCALP_RSI_PE_MIN` | `30` | PE entry blocked at/below this (skip oversold breakdowns that reverse) |
| `SCALP_RSI_TURNING` | `false` | Require RSI momentum to confirm direction (CE: RSI not falling; PE: not rising) |
| `SCALP_PSAR_STEP` / `SCALP_PSAR_MAX` | `0.02` / `0.2` | PSAR — entry side confirmation + initial SL value + candle-close flip exit |
| `SCALP_USE_SUPERTREND` | `false` | Trend-confirmation source. `false` = PSAR (default). `true` = turn PSAR off and use **SuperTrend(10,3)** — it takes over the directional confirmation, the entry SL line **and** the candle-close trend-flip exit. Mutually exclusive; the chart shows whichever is active. |
| `SCALP_SUPERTREND_PERIOD` / `SCALP_SUPERTREND_MULT` | `10` / `3` | SuperTrend ATR period + multiplier (only used when `SCALP_USE_SUPERTREND=true`). |
| `SCALP_MAX_ENTRY_SL_PTS` | `50` | Skip entries where the trend line (PSAR/SuperTrend) is more than this many pts from close (avoids uncapped risk). `0` = off |
| `SCALP_ADX_ENABLED` | `false` | Trend filter — block all entries when ADX(14) is below the floor (sit out chop). |
| `SCALP_ADX_MIN` | `20` | Minimum ADX(14) to allow entries when the trend filter is on (higher = stricter). |
| `SCALP_PROFIT_LOCK_TRIGGER_PTS` | `25` | Arm the profit lock once the favourable spot move (points) hits this. Points-based. `0` disables. |
| `SCALP_PROFIT_LOCK_PCT` | `50` | Once armed, exit when the favourable move falls below this % of peak (ratchets up) — the per-tick upside exit |
| `SCALP_STOP_LOSS_PTS` | `30` | Catastrophic loss cap — exit if the trade moves this many spot points against entry. Wide (only clips deep failed-fade excursions). Points-based. `0` disables. |
| `SCALP_BB_REENTRY_EXIT` | `true` | Exit the instant spot crosses back through the Bollinger Band (failed breakout) — per-tick, at the band line, not the bar close |
| `SCALP_BB_REENTRY_ARM_PTS` | `10` | Only arm the BB re-entry exit once the breakout has extended this many points past the band (avoids stopping a fresh entry on an immediate noise wick). `0` = arm immediately |
| `SCALP_SLIPPAGE_PTS` | `0` | Simulated slippage on entry & SL exit (pts against you) |
| `SCALP_MAX_DAILY_TRADES` | `30` | Daily scalp cap |
| `SCALP_MAX_DAILY_LOSS` | `4000` | Scalp kill-switch in INR |
| `SCALP_VIX_ENABLED` | `false` | Independent VIX filter for scalp |
| `SCALP_VIX_MAX_ENTRY` | `20` (`VIX_MAX_ENTRY` fallback) | Per-mode VIX block-entry threshold |
| `SCALP_VIX_STRONG_ONLY` | `16` (`VIX_STRONG_ONLY` fallback) | Per-mode strong-only threshold |
| `SCALP_SL_PAUSE_CANDLES` | `3` | Pause after SL hit (candles) |
| `SCALP_CONSEC_SL_EXTRA_PAUSE` | `2` | Extra candles pause per consecutive SL after the 2nd |
| `SCALP_PER_SIDE_PAUSE` | `true` | An SL on CE only pauses CE entries; PE remains free |
| `SCALP_ENTRY_START` / `SCALP_ENTRY_END` | `09:21` / `14:30` | Entry window (IST) |
| `SCALP_EXPIRY_DAY_ONLY` | `false` | Only allow scalp entries on weekly-expiry day |

### Price Action Mode (5-min, Fyers)
| Key | Default | Notes |
|-----|---------|-------|
| `PA_MODE_ENABLED` | `true` | Show/hide PA menus in sidebar (also hides PA section in Settings) |
| `PA_ENABLED` | `false` | Must be `true` for Fyers PA live orders |
| `PA_RESOLUTION` | `5` | Candle size in minutes (`5` or `3`) |
| `PA_ENTRY_START` / `PA_ENTRY_END` | `09:20` / `14:30` | Entry window (IST) |
| `PA_SL_BUFFER_PTS` | `3` | Points beyond the pattern level where the structural SL sits |
| `PA_MAX_SL_PTS` | `25` | Hard cap on structural SL distance |
| `PA_MIN_SL_PTS` | `8` | Floor for SL distance |
| `PA_BREAKEVEN_TRIGGER` | `300` | Once peak PnL ≥ ₹N, lift SL to entry+buffer. `0` disables. |
| `PA_BREAKEVEN_BUFFER` | `1` | Spot pts above (CE) / below (PE) entry for the breakeven SL |
| `PA_CHART_PATTERN_TOL` | `12` | Tolerance (pts) for "equal" twin tops/bottoms and flat S/R lines |
| `PA_MIN_BODY` | `5` | Minimum breakout-candle body (pts) |
| `PA_SR_LOOKBACK` | `30` | Candles scanned for swing highs/lows (detection + structure trail) |
| `PA_PATTERN_DOUBLE_BOTTOM` | `true` | Toggle Double Bottom (W) → CE |
| `PA_PATTERN_DOUBLE_TOP` | `true` | Toggle Double Top (M) → PE |
| `PA_PATTERN_ASC_TRIANGLE` | `true` | Toggle Ascending Triangle → CE |
| `PA_PATTERN_DESC_TRIANGLE` | `true` | Toggle Descending Triangle → PE |
| `PA_MAX_DAILY_TRADES` | `30` | Daily PA cap |
| `PA_MAX_DAILY_LOSS` | `2000` | PA kill-switch in INR |
| `PA_VIX_ENABLED` | `false` | Independent VIX filter for PA |
| `PA_VIX_MAX_ENTRY` | `20` (`VIX_MAX_ENTRY` fallback) | Per-mode VIX block-entry threshold |
| `PA_EXPIRY_DAY_ONLY` | `false` | Only allow PA entries on weekly-expiry day |

### ORB Mode (Opening Range Breakout, Fyers)
| Key | Default | Notes |
|-----|---------|-------|
| `ORB_MODE_ENABLED` | `true` | Show/hide ORB menus in sidebar (and Settings section) |
| `ORB_LIVE_ENABLED` | `false` | Must be `true` AND `LIVE_HARNESS_DRY_RUN=false` for real Fyers orders |
| `ORB_EXPIRY_DAY_ONLY` | `false` | Only trade ORB on weekly-expiry day (Tuesday) |
| `ORB_RANGE_START` / `ORB_RANGE_END` | `09:15` / `09:30` | Opening-range window (IST) |
| `ORB_ENTRY_END` | `12:00` | Stale-breakout cutoff (no new entries past this) |
| `ORB_FORCED_EXIT` | `15:15` | Hard EOD square-off |
| `ORB_MIN_RANGE_PTS` / `ORB_MAX_RANGE_PTS` | `25` / `120` | Range-width band |
| `ORB_MIN_BODY` | `8` | Min breakout candle body (pts) |
| `ORB_SL_CANDLES` | `2` | The only stop: SL = swing of last N closed candles (CE → lowest low, PE → highest high), ratcheted on each candle close. Same level is initial SL + trail. No premium SL / profit target. |
| `ORB_TARGET_RANGE_MULT` | `1.5` | Informational target line only (no longer an exit) |
| `ORB_WICK_FILTER_ENABLED` / `ORB_MAX_WICK_RATIO` | `true` / `0.6` | Reject candles whose opposing wick exceeds ratio × body |
| `ORB_VWAP_FILTER_ENABLED` | `true` | CE only above VWAP, PE only below (falls back to TWAP for volumeless candles) |
| `ORB_VOL_FILTER_ENABLED` | `true` | Breakout volume ≥ multiplier × avg of prior N (auto-skipped on volumeless indices) |
| `ORB_VOL_MULT` / `ORB_VOL_LOOKBACK` | `1.2` / `5` | Volume filter inputs |
| `ORB_PREMIUM_GATE_ENABLED` | `true` | Skip when ATM LTP is outside `[ORB_PREMIUM_MIN, ORB_PREMIUM_MAX]` |
| `ORB_PREMIUM_MIN` / `ORB_PREMIUM_MAX` | `80` / `250` | Acceptable ATM-premium band (₹) |
| `ORB_SWEET_MIN` / `ORB_SWEET_MAX` / `ORB_STRONG_BODY` | `30` / `80` / `15` | Sweet-spot tiering (STRONG vs MARGINAL) |
| `ORB_VIX_ENABLED` | `false` | Independent VIX filter |
| `ORB_VIX_MAX_ENTRY` / `ORB_VIX_STRONG_ONLY` | `22` / `18` | Per-mode VIX thresholds |
| `ORB_MAX_DAILY_TRADES` | `1` | Textbook 1/day — raise only if you accept the chop |
| `ORB_MAX_DAILY_LOSS` | `3000` | ORB kill-switch (INR) |

### Straddle Mode (Long Straddle — Volatility, Fyers)
| Key | Default | Notes |
|-----|---------|-------|
| `STRADDLE_MODE_ENABLED` | `true` | Show/hide Straddle menus in sidebar (and Settings section) |
| `STRADDLE_LIVE_ENABLED` | `false` | Master switch for paired-leg Fyers live orders |
| `STRADDLE_EXPIRY_DAY_ONLY` | `false` | Only allow straddle entries on expiry day |
| `STRADDLE_ENTRY_START` / `STRADDLE_ENTRY_END` | `09:30` / `11:00` | Entry window (IST) — late straddles bleed theta |
| `STRADDLE_FORCED_EXIT` | `15:15` | Hard EOD exit for any open pair |
| `STRADDLE_BB_PERIOD` / `STRADDLE_BB_STDDEV` | `20` / `2` | Squeeze-trigger BB inputs |
| `STRADDLE_BB_AVG_LOOKBACK` | `20` | Bars to average BB width (squeeze baseline) |
| `STRADDLE_SQUEEZE_RATIO` | `0.85` | Current width ≤ ratio × avg → squeeze fires |
| `STRADDLE_TARGET_PCT` / `STRADDLE_STOP_PCT` | `0.20` / `0.30` | Exit at netDebit × (1 + N) / (1 − N) |
| `STRADDLE_MAX_HOLD_DAYS` | `0.3` | Intraday-only time-stop (paper auto-stops at EOD anyway) |
| `STRADDLE_FORCE_ENTRY_NEXT` | `false` | One-shot override for event days — auto-resets after firing |
| `STRADDLE_VIX_ENABLED` | `true` | Block when VIX is pumping (poor R:R) |
| `STRADDLE_VIX_MAX_ENTRY` / `STRADDLE_VIX_STRONG_ONLY` | `22` / `18` | Per-mode VIX thresholds |
| `STRADDLE_VIX_CHEAP` | `14` | Below this VIX → cheap-premium entry path triggers |
| `STRADDLE_MAX_DAILY_PAIRS` | `1` | Cap on pair entries per day |
| `STRADDLE_MAX_DAILY_LOSS` | `3000` | Straddle kill-switch (INR) |

### Paper Investment Pools (per broker)
Paper capital is pooled per broker, not per strategy. Each strategy's running capital = its broker pool + that strategy's all-time paper P&L. The Real-Time Monitor (dashboard) shows each pool's remaining balance.
| Key | Default | Notes |
|-----|---------|-------|
| `ZERODHA_INV_AMOUNT` | `100000` | Paper investment pool for Zerodha strategies (Swing) |
| `FYERS_INV_AMOUNT` | `100000` | Paper investment pool for Fyers strategies (Scalp + PA + ORB + Straddle) |

### VIX Filter (per-module)
| Key | Default | Notes |
|-----|---------|-------|
| `VIX_FILTER_ENABLED` | `true` | Block Swing entries in high-VIX |
| `VIX_MAX_ENTRY` | `20` | Swing block-all-entries threshold |
| `VIX_STRONG_ONLY` | `16` | Swing strong-only threshold |
| `VIX_FAIL_MODE` | `closed` | When VIX unavailable: closed = block (safe), open = allow |
| `SCALP_VIX_ENABLED` | `false` | Independent toggle |
| `SCALP_VIX_MAX_ENTRY` | inherits | Per-mode threshold (falls back to `VIX_MAX_ENTRY` if unset) |
| `SCALP_VIX_STRONG_ONLY` | inherits | Per-mode threshold (falls back to `VIX_STRONG_ONLY`) |
| `PA_VIX_ENABLED` | `false` | Independent toggle |
| `PA_VIX_MAX_ENTRY` | inherits | Per-mode threshold |

### OI + Price Buildup Filter (per-module)
Blocks directional entries that fight the prevailing Open-Interest buildup: reads NIFTY current-expiry **futures OI** vs spot over a short lookback (Settings → *Open-Interest Filter*), classifies the regime, and blocks **CE in a SHORT_BUILDUP** and **PE in a LONG_BUILDUP**. Weak (short-covering / long-unwinding), neutral, warmup, and OI-missing all **fail open** (allow). **Live/paper only — never evaluated in backtest/replay** (OI is not recorded in tick files). **Straddle is excluded** (delta-neutral). Each entered trade records `oiAtEntry` + `oiRegime` and appends the regime to `entryReason`; blocks are logged to the skip log under `gate:"oi"`.

| Key | Default | Notes |
|-----|---------|-------|
| `OI_FILTER_ENABLED` | `false` | **Master switch** — OFF disables the filter for every strategy regardless of the per-mode toggles |
| `SWING_OI_ENABLED` | `false` | Apply to Swing (requires master ON) |
| `SCALP_OI_ENABLED` | `false` | Apply to Scalp (requires master ON) |
| `PA_OI_ENABLED` | `false` | Apply to PA (requires master ON) |
| `ORB_OI_ENABLED` | `false` | Apply to ORB (requires master ON) |
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
| `TICK_RECORDER_ENABLED` | `true` | Record spot/option/VIX ticks to `~/trading-data/ticks/YYYY-MM-DD/*.jsonl` during every paper/live session. Required for Replay. Pure observer — zero impact on trading. |
| `TICK_RECORDER_RETAIN_DAYS` | `30` | Auto-delete tick recordings older than this many days (~10 MB/day across streams) |
| `SETTINGS_AUDIT_RETAIN_DAYS` | `3` | Keep only this many days of `settings-audit.jsonl` (the Trade Logs → Checkpoints & Settings Changes tab); older entries are pruned on every save and never shown |
| `BACKUP_ENABLED` | `true` | Cut a daily self-contained `.tar.gz` snapshot of `~/trading-data` + `data/ticks` (caches & OAuth tokens excluded) into `~/trading-data/_backups/`. Download it from Settings → Backup & Restore; a banner nags on every page until the day's copy is downloaded. Pure observer — zero impact on trading. |
| `BACKUP_HOUR_IST` | `16` | Hour of day (IST) the daily snapshot is cut (after market close). Timer armed at boot — restart to re-arm a changed hour. |
| `BACKUP_RETAIN_DAYS` | `14` | Daily snapshots keep only the latest (a new one deletes the old). This prunes the hidden pre-restore safety snapshots older than this many days. |
| `BACKUP_TG_ENABLED` | `false` | Send a Telegram message when each day's snapshot is ready (or if it fails). |
| `LIVE_HARNESS_DRY_RUN` | `true` | **Global** kill-switch. When ON, all live order paths (PA/ORB/Straddle harness routes **and Swing Live**) log the broker call that *would* have been made but place no real order. When OFF, each strategy goes real **unless** its own `{STRATEGY}_LIVE_DRY_RUN` override is on. Switch OFF only after verifying decisions match paper. |
| `SWING_LIVE_DRY_RUN` | `false` | Per-strategy override — keeps Swing in dry-run even when `LIVE_HARNESS_DRY_RUN=false`. Lets you take other strategies live while Swing stays simulated (and vice-versa). |
| `ORB_LIVE_DRY_RUN` | `false` | Per-strategy override — keeps ORB in dry-run even when the global flag is off. |
| `PA_LIVE_DRY_RUN` | `false` | Per-strategy override — keeps the PA live harness in dry-run even when the global flag is off. |
| `STRADDLE_LIVE_DRY_RUN` | `false` | Per-strategy override — keeps Straddle in dry-run even when the global flag is off. |
| `SCALP_LIVE_DRY_RUN` | `false` | Per-strategy override — keeps Scalp in dry-run even when the global flag is off. Scalp Live has no master-enable gate, so this (with the global flag) is its primary safety switch. |
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
| `{SWING,SCALP,PA,ORB,STRADDLE}_MODE_ENABLED` | `true` | Master toggle — hides sidebar group AND Settings section for that strategy |
| `UI_SHOW_SIMULATE` | `false` | Show "Simulate" link under each mode in sidebar |
| `UI_SHOW_COMPARE` | `false` | Show "Compare" link |
| `UI_SHOW_TRACKER` | `false` | Show "Tracker" under Swing |
| `UI_SHOW_{SWING,SCALP,PA,ORB,STRADDLE}_{BACKTEST,PAPER,LIVE,HISTORY}` | `true` | Per-submenu toggles for each strategy group |
| `UI_SHOW_PA_LIVE_HARNESS` | `false` | Show "Live (Harness)" inside the PA group |
| `UI_SHOW_{SWING,SCALP,ORB}_LIVE_HARNESS` | `false` | Show "Live (Harness)" inside the Swing/Scalp/ORB group — runs LIVE by wrapping PAPER (LIVE = PAPER) |
| `UI_SHOW_PA_PATTERN_BACKTEST` | `true` | Show "Pattern Test" inside the PA group |
| `UI_SHOW_LOGS` / `UI_SHOW_TRADE_LOGS` / `UI_SHOW_CACHE_FILES` | `true` | System menu items |

> Per-menu / per-submenu visibility toggles are also configurable via the Settings UI — hide entire mode sections (Swing / Scalp / PA / ORB / Straddle) from the sidebar without disabling the underlying engine, or hide individual links (e.g., hide Backtest but keep Paper + Live) within a still-visible mode section. Driven by env vars + Settings UI; persists across restart.

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
| `TG_{SWING,SCALP,PA,ORB,STRADDLE}_STARTED` | `true` | Session-start alerts per mode |
| `TG_{SWING,SCALP,PA,ORB,STRADDLE}_ENTRY` | `true` | Trade-entry alerts per mode |
| `TG_{SWING,SCALP,PA,ORB,STRADDLE}_EXIT` | `true` | Trade-exit alerts per mode |
| `TG_{SWING,SCALP,PA}_SIGNALS` | `true/false/false` | Candle-close skip/signal reasoning (Swing/Scalp/PA only — ORB/Straddle emit no signal alerts) |
| `TG_{SWING,SCALP,PA,ORB,STRADDLE}_DAYREPORT` | `true` | Per-mode day-report on session stop |
| `TG_DAYREPORT_CONSOLIDATED` | `true` | One combined day report at 15:30 IST across all five modes |

> All alerts and the consolidated report also respect the strategy master toggles (`{SWING,SCALP,PA,ORB,STRADDLE}_MODE_ENABLED`): a disabled strategy sends no alerts and is omitted from the consolidated report, regardless of its `TG_*` toggles.

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

### Swing
| URL | Description |
|-----|-------------|
| `/` | Dashboard (with Start-All Paper / Start-All Live buttons) |
| `/swing-backtest` | Run backtest (3/5/15-min EMA 20/50+RSI+SuperTrend) |
| `/swing-paper/status` | Paper trade live view + NIFTY chart |
| `/swing-paper/history` | Past paper sessions (per-session delete + view modal) |
| `/swing-paper/simulate` | Market scenario simulator |
| `/swing-live/status` | Live trade status + NIFTY chart (Zerodha; gated by `SWING_LIVE_ENABLED` + `LIVE_HARNESS_DRY_RUN`) |
| `/tracker/status` | Manual trade tracker |

### Scalp
| URL | Description |
|-----|-------------|
| `/scalp-backtest` | Scalp backtest (3/5-min BB+PSAR+RSI V5) |
| `/scalp-paper/status` | Scalp paper trade + NIFTY chart with BB overlay |
| `/scalp-paper/history` | Past scalp sessions (per-session delete + view modal) |
| `/scalp-paper/simulate` | Scalp simulator |
| `/scalp-live/status` | Scalp live trade + NIFTY chart |

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
| `/swing-live-harness` | Swing live via the paper-wrapping harness (Zerodha orders). `/start` + `/stop` gated by `LIVE_HARNESS_DRY_RUN` (+ `SWING_LIVE_DRY_RUN`). |
| `/scalp-live-harness` | Scalp live via the paper-wrapping harness (Fyers orders). `/start` + `/stop` gated by `LIVE_HARNESS_DRY_RUN` (+ `SCALP_LIVE_DRY_RUN`). |
| `/orb-live-harness` | ORB live via the paper-wrapping harness (Fyers orders). `/start` + `/stop` gated by `LIVE_HARNESS_DRY_RUN` (+ `ORB_LIVE_DRY_RUN`). |

### ORB (Opening Range Breakout)
| URL | Description |
|-----|-------------|
| `/orb-backtest` | ORB date-range backtest |
| `/orb-paper/status` | ORB paper trade + ORH/ORL overlay |
| `/orb-paper/history` | ORB sessions (per-session delete + view modal) |
| `/orb-live/status` | ORB live trade (Fyers; gated by `ORB_LIVE_ENABLED` + `LIVE_HARNESS_DRY_RUN`) |

### Straddle (Long Straddle — Volatility)
| URL | Description |
|-----|-------------|
| `/straddle-backtest` | Straddle date-range backtest |
| `/straddle-paper/status` | Straddle paper trade — paired CE+PE legs, combined-premium chart |
| `/straddle-paper/history` | Straddle sessions (per-session delete + view modal) |
| `/straddle-live/status` | Straddle live trade (paired Fyers orders; partial-fill alert via Telegram) |

### Analytics & Tools
| URL | Description |
|-----|-------------|
| `/realtime` | **Unified real-time monitor** — one screen for all enabled strategies with a PAPER/LIVE toggle. Cards for Swing / Scalp / PA / ORB / Straddle (each card is hidden when its `{STRATEGY}_MODE_ENABLED` is off) showing open position + today's stats, with a rollup table for **Today Total (Open + Closed)**. Read-only; polls each strategy's `/status/data` every 4s. Theme-aware. **Per-card Open Status + Copy Day Log buttons** (Copy Day Log copies raw entry + skip JSONL, not the human-readable summary). |
| `/replay` | **Tick Replay** — deterministic re-run of a recorded paper session through the paper `onTick()` handlers. Single-date and date-range modes. Snapshot mode (session-start settings) vs current-settings mode (live `process.env`). Per-row diagnostic Replay buttons + downloadable diagnostic dump. Outputs land in `~/trading-data/_replay_trades/` (snapshot) or `_replay_trades_sim/` (current). |
| `/all-backtest` | **Unified backtest dashboard** — runs the same date range across all enabled strategies and renders the per-strategy stats side by side. |
| `/consolidation` | Cross-mode **paper** trade history + analytics (Swing + Scalp + PA, daily/monthly/yearly roll-ups, Day View panel, per-mode breakdown) |
| `/live-consolidation` | Cross-mode **live** trade history + analytics (parity with `/consolidation` for live data) |
| `/edge-analytics` | **Edge Analytics** — read-only edge dashboard over your recorded trades. Paper/Live book toggle + per-strategy + date-range (7D / 30D / FY / custom) filters that recompute instantly client-side. Headline cards (trades, win rate, net P&L, expectancy, profit factor, avg win/loss + payoff, max drawdown, win/loss streaks), an equity curve, P&L-by-hour-of-day and P&L-by-weekday bar charts, and **By Strategy** + **By Exit Reason** breakdown tables (worst reason first, to surface the bleed). Reads the same session files as `/consolidation` + `/live-consolidation`; writes nothing. Gated by `UI_SHOW_EDGE_ANALYTICS`. |
| `/pnl-history` | Broker-wise realised P&L (one-time past baselines per broker + auto-computed live-bot P&L by FY) |
| `/compare/trading` | Paper vs Backtest comparison (swing) |
| `/compare/scalping` | Paper vs Backtest comparison (scalping) |
| `/settings` | All config settings UI + Bulk Edit modal (paste/delete keys) + **checkpoint note prompt on every save** + server restart. Saved notes are appended to that day's trade JSONL alongside a settings snapshot, so the daily log carries the exact config that produced its trades. |
| `/trade-logs` | **Renamed from JSONL viewer in v4.5.0.** Per-mode trade-log file manager: per-day trade entries + cumulative skip logs in a separate tab. Per-mode **Download All** + **Delete All** buttons, plus a single **Download Everything (all strategies)** button on both the Trade Files and Skip Logs tabs (`/trade-logs/download-everything` and `/trade-logs/skips/download-everything`) that concatenates every mode's daily files into one self-describing JSONL (each line carries its own `mode`). JSONL is the canonical export format (CSV/PDF dropped — they were drifting on edge cases). The **Checkpoints & Settings Changes** tab now has a per-row **↩ Restore** button that reverts a key to its prior value (with a "restore all keys with the same note" checkbox when the entry has a note, and a one-click restart prompt when needed). Light-theme aware. |
| `/cache-files` | Cache / generated-file browser. Groups every on-disk cache by purpose — **Backtest Cache**, **Candle Cache**, **Recorded Ticks**, **Replay Trades** (snapshot + sim), and **Root Data Files** — each with per-file **View** / **Download** / **Delete** plus group **Download All** (`.tar.gz`) + **Delete All**. Read endpoints are open; deletes require `API_SECRET`. Path-traversal-guarded. The canonical trade/skip JSONLs keep their own page (`/trade-logs`); deleting a cache here is safe (regenerated on demand). Gated by `UI_SHOW_CACHE_FILES`. Light-theme aware. |
| `/monitor` | EC2 health metrics (CPU, RAM, disk, load average) + maintenance actions |
| `/logs` | Application logs (with SSE live feed; near-miss audit lines visible here). **Copy Log button** in the activity-log header on paLive / paPaper / swingLive / swingPaper. |
| `/docs` | README, CHANGELOG, documents viewer |
| `/login-logs` | Failed login attempts with geolocation (now linked from Settings top-bar; not in sidebar) |
| `/deploy/status` | GitHub Actions deploy status |
| `/health` | Health check endpoint |

### Reset Endpoints (per-mode live history)
| URL | Description |
|-----|-------------|
| `POST /swing-live/reset` | Clear Swing live trade history (gated when session active) |
| `POST /scalp-live/reset` | Clear Scalp live trade history |
| `POST /pa-live/reset` | Clear PA live trade history |
| `POST /orb-live/reset` | Clear ORB live trade history |
| `POST /straddle-live/reset` | Clear Straddle live trade history |

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
| `POST /{swing|scalp|pa}-paper/history/restore` | Rebuild a deleted session for an IST date by replaying the daily JSONL trade log (idempotent; refuses while paper running) |

## Project Structure

```
src/
  app.js                              # Express server, dashboard, route registration, Start-All
  strategies/
    strategy1_sar_ema_rsi.js          # Swing strategy (EMA 20/50 (+9 opt) + RSI + SuperTrend) — 5-min default; 15-min via TRADE_RESOLUTION=15
    scalp_bb_cpr.js                   # Scalp 3/5-min V5 (BB break + PSAR side + RSI)
    price_action.js                   # Price action 5-min strategy (patterns + S/R + RSI caps + BE trigger)
    orb_breakout.js                   # ORB strategy (15-min opening range; CE/PE single-leg breakout buys)
    straddle_volatility.js            # Long Straddle (BB-squeeze paired CE+PE for volatility expansion)
    index.js                          # Active-strategy registry (currently exposes Swing; ORB/Straddle invoked by their own routes)
  services/
    backtestEngine.js                 # Historical candle fetch + backtest engine
    tickSimulator.js                  # Market scenario tick generator + historical replay (zigzag ticks)
    tickRecorder.js                   # Spot/option/VIX tick recorder (writes ~/trading-data/ticks/...) for Replay
    vixFilter.js                      # VIX market regime filter
    zerodhaBroker.js                  # Zerodha Kite order placement (swing live)
    fyersBroker.js                    # Fyers order placement (scalp + PA + ORB + Straddle live)
    logger.js                         # Console interceptor + in-memory log store
  routes/
    swingLive.js                      # Swing live (5-min default, Zerodha) + chart + /reset endpoint + STRONG_ONLY gate
    swingPaper.js                     # Swing paper (5-min default, simulated) + chart + view modal + history JSONL download + STRONG_ONLY gate
    swingBacktest.js                  # Swing backtest (5-min default, split-by-years/months)
    scalpLive.js                      # Scalp live (5-min, Fyers) + chart + BB overlay + /reset endpoint
    scalpPaper.js                     # Scalp paper (5-min, simulated) + chart + BB overlay
    scalpBacktest.js                  # Scalp backtest
    paLive.js                         # PA live (legacy code path, Fyers) + chart + swing overlay + /reset endpoint
    paLiveHarness.js                  # PA live via paper-wrapping harness — LIVE = PAPER by construction, gated by LIVE_HARNESS_DRY_RUN
    paPaper.js                        # PA paper (5-min, simulated) + chart + swing overlay + BE trigger
    paBacktest.js                     # PA backtest
    paPatternBacktest.js              # PA per-pattern attribution backtest
    orbLive.js                        # ORB live (Fyers) — gated by ORB_LIVE_ENABLED + LIVE_HARNESS_DRY_RUN
    orbPaper.js                       # ORB paper + ORH/ORL chart overlay
    orbBacktest.js                    # ORB date-range backtest (records option LTP polls so Replay can reproduce)
    straddleLive.js                   # Straddle live (paired Fyers orders + partial-fill Telegram alert)
    straddlePaper.js                  # Straddle paper — paired CE+PE legs, combined-premium chart
    straddleBacktest.js               # Straddle date-range backtest
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
    sharedSocketState.js              # Mode coexistence manager (Swing/Scalp/PA/ORB/Straddle aware)
    sharedNav.js                      # Sidebar (accordion) + per-feature menu toggles
    positionPersist.js                # Crash recovery — position save/load (Swing/Scalp/PA only; ORB/Straddle TBD)
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
- **Brokers**: Zerodha Kite Connect (swing live) + Fyers API v3 (scalp + PA live + all data)
- **Notifications**: Telegram Bot API with 17 per-mode toggles + master gate + consolidated EOD
- **Charts**: Chart.js (theme-aware) + live candlestick overlays on status pages
- **Deployment**: PM2 on AWS EC2 t3.micro + GitHub Actions CI/CD
- **Caching**: Disk-based candle cache (backtest + live, auto-pruned)
- **Compression**: gzip middleware on all HTTP responses (≈80% size reduction on `/settings`; ~329 KB → 61 KB)

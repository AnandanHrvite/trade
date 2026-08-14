# BB_RSI Strategy — Bollinger Band mean reversion + RSI extreme

*Rebuilt 2026-08-14 as **V8 — mean reversion**. This is a direction flip, not a tuning pass: V7 bought the BREAK (CE when price closed **above** the upper band); V8 **fades** it (CE when price closes **below** the lower band). SuperTrend, the BB re-entry exit and the trend-flip exit are gone; the middle-band target, the two-opposite-candle stop/trail, the chop guards and the divergence filter are new. Anything below dated earlier describes V7 and no longer runs.* Authoritative description of the **current** BB_RSI logic, transcribed from the code:
- Entry signal: [src/strategies/bb_rsi.js](src/strategies/bb_rsi.js) (`getSignal`) — shared by all three modes.
- Order/exit/trail management: [src/routes/bbRsiPaper.js](src/routes/bbRsiPaper.js) (paper is canonical) / [src/routes/bbRsiLive.js](src/routes/bbRsiLive.js). Backtest: [src/routes/bbRsiBacktest.js](src/routes/bbRsiBacktest.js). Replay drives the paper engine and inherits automatically.

All numeric values below are the **code defaults**; every one is overridable from the Settings UI (env var in parentheses).

Timeframe: **3 / 5 / 15-min** candles via the global `TRADE_RESOLUTION` (default 5) — shared by every strategy. BB and RSI use **close**. Broker: **Fyers** (live + all data); paper is simulated on the same tick feed.

---

## 0. The idea

Price that has stretched a long way from its own average tends to come back to it. So when a candle closes **outside** the Bollinger band **and** RSI confirms the move is an exhausted extreme, the engine buys the option that profits from the snap-back — and takes profit at the mean.

The whole risk in this design is the market that keeps going. Two things address it: the **chop guards** (§3b), which refuse the sideways tape where band touches are meaningless, and the **two-opposite-candle stop** (§5), which gets out fast when the fade is wrong.

## 1. Pre-conditions

| Check | Rule |
|-------|------|
| Warm-up | Need ≥ **30** candles before any signal (`max(BB_PERIOD+5, RSI_PERIOD+5, 30)`). |
| Trading window | New entries only between `BB_RSI_ENTRY_START` **09:21** and `BB_RSI_ENTRY_END` **14:30** IST. |

## 2. Indicators computed each candle

- **Bollinger Bands** — period `BB_RSI_BB_PERIOD(30)`, std-dev `BB_RSI_BB_STDDEV(2)`, on close. (Charting-standard 30/2, matching the TradingView setup this design was drawn from.)
- **RSI(14)** (close) — `BB_RSI_RSI_PERIOD`. The whole series is kept, not just the latest value: the RSI-range guard and the divergence scan both need history.
- **ADX(14)** — computed every candle for charting/logging; only gates entries when the ADX ceiling is on (§3b).

## 3. Entry — evaluated at candle close

**CE (long call) — fades a drop:**
- Candle **closes at/below the BB lower band** — `close ≤ BB.lower`
- `RSI ≤ BB_RSI_RSI_CE_THRESHOLD(25)` — oversold
- → SL line = **the signal candle's LOW**, target = **the BB middle band**

**PE (long put) — fades a rip:**
- Candle **closes at/above the BB upper band** — `close ≥ BB.upper`
- `RSI ≥ BB_RSI_RSI_PE_THRESHOLD(75)` — overbought
- → SL line = **the signal candle's HIGH**, target = **the BB middle band**

> **The thresholds swapped ends of the scale.** In V7, CE needed RSI **above** 70. In V8, CE needs RSI **at or below 25**. The key names are unchanged, so a V7 `.env` carried over unedited will produce an engine that almost never trades (`RSI ≤ 65` for CE is common, but it also needs a close *below* the lower band, which rarely coincides). Migrate the values.

**Entry stop line** = the signal candle's own extreme, clamped by `BB_RSI_MAX_ENTRY_SL_PTS(50)`: if the signal candle's close-to-extreme distance is wider than that, the entry is skipped, so one huge bar cannot open a position with uncapped risk (`0` disables). The line is recorded and displayed for sizing — it is **not** an intra-tick stop. The live stop is §5.

Optional `BB_RSI_RSI_TURNING` (default off): also require RSI to have **already turned back** (CE: RSI rising vs the prior bar; PE: falling) — the earliest confirmation that the stretch is spent. All valid signals enter at the `BB_RSI` strength tier; `signalStrength()` rates a signal STRONG when RSI is a further 5 points **deeper** into the extreme (CE ≤ 20, PE ≥ 80).

### 3a. Confirmation candle (`BB_RSI_CONFIRM_CANDLE_ENABLED`, default **ON**)

The signal candle does **not** enter. With confirmation on (the shipped default), a fully-closed candle must satisfy §3 (the *signal candle*), and then the **next** candle must cross that signal candle's close — CE above / PE below, i.e. in the direction of the expected reversal.

`BB_RSI_CONFIRM_ON_CLOSE` (default **ON**) decides *when* that cross counts: on = the next candle must **CLOSE** past the signal close, and entry fires at that close; off = entry fires **intra-bar** the instant price crosses. For a fade, on is the safer default — a poke up from an oversold extreme that closes back down is not a reversal, it is a falling knife.

> Replaces `BB_RSI_CONFIRM_OUTSIDE_BAND`, which additionally required the confirmation candle to close **outside** the band. That only made sense for a breakout; a mean-reversion entry wants price coming **back** toward the band, so the old test would have vetoed every valid confirmation. Delete the old key.

### 3b. Chop guards — the sideways-market problem

A flat tape pins price to a band that has collapsed to noise width. The fade signal then repeats every few candles and each one bleeds. Three independent guards:

| Guard | Rule | Default |
|-------|------|---------|
| **Band width** (`BB_RSI_BAND_WIDTH_ENABLED`) | `BB.upper − BB.lower ≥ BB_RSI_MIN_BAND_WIDTH_PTS(50)`. A skinny band is not a stretch. | **on** |
| **RSI range** (`BB_RSI_RSI_RANGE_ENABLED`) | Over the `BB_RSI_RSI_RANGE_LOOKBACK(20)` candles **ending at the previous bar**, `max(RSI) − min(RSI) ≥ BB_RSI_RSI_RANGE_MIN(30)`. | **on** |
| **ADX ceiling** (`BB_RSI_ADX_ENABLED`) | Block when `ADX(14) ≥ BB_RSI_ADX_MAX(30)`. | off |

Two notes that matter:

- The RSI-range window deliberately **excludes the signal bar**. Including it would make the test self-satisfying — the bar's own spike to 75/25 is exactly the excursion being measured, so a dead tape with a single poke would always pass. Excluding it asks the honest question: *has this market been alive recently?*
- The **ADX gate is inverted vs V7**. V7 blocked when ADX was **low** (a breakout needs a trend). V8 blocks when ADX is **high** — a fade is run over by a strong trend. The key was renamed `BB_RSI_ADX_MIN` → `BB_RSI_ADX_MAX` so the two can never be confused.

### 3c. Divergence filter (`BB_RSI_DIVERGENCE_ENABLED`, default **OFF**)

The classic reversal tell: price makes a new extreme that RSI does not confirm.

- **CE**: the signal bar's **low** is below the most recent confirmed pivot low, while RSI is **above** its value at that pivot (a lower low on a higher RSI low).
- **PE**: the signal bar's **high** is above the most recent confirmed pivot high, while RSI is **below** its value there.

A pivot needs `BB_RSI_DIV_PIVOT_BARS(2)` bars either side to be confirmed and is searched for within `BB_RSI_DIV_LOOKBACK(20)` bars. The newer comparison point is the **signal bar itself**, not a second confirmed pivot — waiting for one would put the entry several candles after the extreme being faded.

If no pivot exists in range, the gate **fails closed** (blocked). An unprovable filter must not wave the trade through.

## 4. Optional protective caps

Both default to letting §5 do the work; both are per-tick, in spot points, so they work even on spot-proxy sessions.

- **Hard stop** (`BB_RSI_STOP_LOSS_PTS(30)`, `0` disables) — exit once the trade moves this many points **against** entry. This is a genuine backstop, not a formality: the two-opposite-candle stop can only fire on a **candle close**, and a single violent bar against a fade travels a long way before that close arrives. Arms the per-side SL cooldown.
- **Profit lock** (`BB_RSI_PROFIT_LOCK_TRIGGER_PTS(0)` = **off**, `BB_RSI_PROFIT_LOCK_PCT(50)`) — once the peak favourable move reaches the trigger, exit when it gives back below `PCT%` of that peak (ratchets). Off by default because it fires *before* the mean is reached and would cut the trade short of its whole objective.

## 5. Exit rules

In the order each engine evaluates them:

1. **Hard stop** (per tick) — §4. Arms the SL cooldown.
2. **Profit lock** (per tick) — §4. Off by default.
3. **Middle-band target** (`BB_RSI_TARGET_MIDDLE_BAND`, default **on**) — per tick, exit when price reaches the BB middle band. This is the objective of the trade: the mean is what price is reverting *to*. CE completes on the way **up** to it, PE on the way **down**. Filled at the observed tick (a market exit the instant the mean is reached, not a resting limit at the line).
4. **Two-opposite-candle stop / trail** — the only candle-close exit, and the one the operator asked for. An "opposite" candle is one whose **body** closed against the position: CE is hurt by a **red** body (`close < open`), PE by a **green** one. A doji (`close === open`) is *not* opposite and **breaks** the streak — it is indecision, not a move against the trade.

   | Phase | When | Toggle / count |
   |-------|------|----------------|
   | **Stop** | before the trade has run `BB_RSI_TRAIL_ARM_PTS(10)` in favour | `BB_RSI_OPP_CANDLE_SL_ENABLED` (on) / `BB_RSI_OPP_CANDLE_SL_COUNT(2)` |
   | **Trail** | after it has | `BB_RSI_OPP_CANDLE_TRAIL_ENABLED` (on) / `BB_RSI_OPP_CANDLE_TRAIL_COUNT(2)` |

   The streak only counts candles that closed **after entry** (capped at the position's `candlesHeld`). Without that cap it would reach back through the entry candle and the signal candle before it — on a CE fade both are typically red, being the tail of the sell-off being faded — and a 2-candle stop would fire on the very first close after entry, killing a trade that never got a single bar to work.

   The two are **independently toggleable**. Turn the trail off and the initial stop stays live for the whole trade; turn the stop off and nothing fires until the trail arms (the hard stop still applies either way). The stop's exit reason contains `"SL"`, which is what arms the per-side cooldown in every route; the trail's deliberately does **not** — a trail exit banks a profit and must not pause the side.
5. **EOD square-off** at `TRADE_STOP_TIME(15:30)` IST (with an earlier backup just before).
6. **Daily kill-switch / max trades** — see risk guards.
7. Bid-ask spread guard shared via [src/utils/tradeGuards.js](src/utils/tradeGuards.js).

There is **no** break-even snap, no percentage spot-trail, no time-stop, and no BB re-entry exit — closing back inside the band is now the trade's *goal*, not a failure.

## 5a. Malformed config

Every numeric setting the engine reads is parsed **strictly**: a value that is not a clean number falls back to the **documented default**, never to `NaN` and never to a half-parsed number. This matters more here than it looks. A `NaN` threshold makes every comparison against it false, which switches a chop guard **off** rather than on, and a bare `parseFloat("5o")` hands back `5` when you meant `50` — both silent, both in the dangerous direction. The entry window behaves the same way: a malformed `HH:MM` (or an impossible one like `25:00`) falls back to `09:21`/`14:30` rather than collapsing to a `NaN` bound, which would remove the window and trade the whole session.

An explicit `0` still parses cleanly, so every documented "`0` = off" opt-out keeps working exactly as before.

This follows two rulings the repo has already made: `boundedExit`'s `LIVE_EXIT_WAIT_MS` falls back rather than removing its ceiling, and EMA9+VWAP's window falls back rather than collapsing to midnight.

## 6. Same-side cooldown

After an **SL hit** on a side, new entries on **that side** are blocked for `BB_RSI_SL_PAUSE_CANDLES(3)` candles (`BB_RSI_PER_SIDE_PAUSE` on = per-side; off = global). Each consecutive SL after the 2nd adds `BB_RSI_CONSEC_SL_EXTRA_PAUSE(2)` extra candles.

## 7. Risk guards & filters

- `BB_RSI_MAX_DAILY_TRADES(30)` — entries per session.
- `BB_RSI_MAX_DAILY_LOSS(4000)` — daily kill-switch (INR).
- **VIX gate**: `BB_RSI_VIX_ENABLED` + `BB_RSI_VIX_MAX_ENTRY(20)` block entries above that VIX; `BB_RSI_VIX_STRONG_ONLY(16)` allows only STRONG signals above its level (bb_rsi-scoped).
- `BB_RSI_SLIPPAGE_PTS` — simulated slippage on entry & exit (paper/backtest).

## 8. Expiry & live gating

- `BB_RSI_EXPIRY_DAY_ONLY` — when on, only trade on NIFTY weekly expiry day.
- **Live order placement is double-gated**: `BB_RSI_ENABLED` **and** global `LIVE_HARNESS_DRY_RUN=false`, with `BB_RSI_LIVE_DRY_RUN` to keep BB_RSI simulated while others go live.
- **Stale expiry override blocks entry (2026-07-26).** The common `OPTION_EXPIRY_OVERRIDE` is stale once past **15:30 IST on its own expiry day** (`instrument.isExpiryOverrideStale()`), so a contract still trades all through its expiry day. A stale override returns `{ invalid: true, symbol: null }` plus the key to fix, and deliberately does **not** fall through to auto-detection. Sessions showing `pnlMode: "spot proxy"` + `no_data` option errors are a data hole, not a result.

## 8a. Live-route parity (2026-07-26) — still current

Three defects where `bbRsiLive` behaved differently from canonical paper, all fixed and pinned by `npm run test:parity`:

1. **Session-teardown race.** `stopSession()` fired `squareOff()` un-awaited, then ran on to the session save and day report while the sell was still at the broker — the saved session was missing its final trade and P&L. Now async and awaited, with `state.running` cleared first.
2. **Unbounded broker wait.** [src/utils/boundedExit.js](src/utils/boundedExit.js) caps it at `LIVE_EXIT_WAIT_MS` (default **20000**, `0` opts out; read per call so Settings applies without a restart). The timeout **cancels nothing** — the alert reads "may still be in flight, verify the dashboard".
3. **`PORTFOLIO_MAX_DAILY_LOSS` was missing from every live route**, so with the cap armed paper stopped entering while live kept trading. All routes now check it. Block-only.

## 9. Charts (paper status, live status, replay)

Plot these on **NIFTY 50 spot** at the same resolution to mirror the engine:
- **Bollinger Bands** — period **30**, std-dev **2**.
- **RSI(14)** — its own bottom scale. The dashed lines are the entry thresholds, and they sit the opposite way round from V7: the **CE** line is the **low** one at `BB_RSI_RSI_CE_THRESHOLD(25)`, the **PE** line the high one at `BB_RSI_RSI_PE_THRESHOLD(75)`.
- **ADX(14)** — its own subplot, with the `BB_RSI_ADX_MAX` ceiling drawn.
- No SuperTrend line — the engine no longer computes one.

## 10. Logging

- Per-candle decision log: `[BB_RSI …] CE/PE FADE: close below/above band + RSI | target=BB mid, SL line`.
- Trade log JSONL: per-trade record carries BB bands / RSI / ADX at entry plus `bandWidthAtEntry`, `rsiRangeAtEntry` and the full `divergenceAtEntry` detail (pivot price, pivot RSI, current price, current RSI, bars back), MFE/MAE, charges, etc.
- Near-miss `filterAudit` tracks the two live entry checks: band stretch and RSI extreme.
- Skip log carries `bbWidth` and `rsiRange`, so a session that took no trades can be read back as *which guard was binding*.

## 11. Removed in the V8 rebuild (2026-08-14)

Gone from the code **and** from Settings — delete them from any `.env` (the Settings bulk-paste box accepts a leading `-KEY` to remove a dead key):

| Removed | Why |
|---------|-----|
| `BB_RSI_SUPERTREND_PERIOD` / `BB_RSI_SUPERTREND_MULT` | SuperTrend agreed with the breakout, so it vetoed every fade. The whole trend source is gone — including the chart line and the `supertrendAtEntry` / `stTrendAtEntry` / `trendSource` trade fields. |
| `BB_RSI_BB_REENTRY_EXIT` / `BB_RSI_BB_REENTRY_ARM_PTS` | Closing back inside the band is now the target, not a failed breakout. |
| `BB_RSI_ADX_MIN` | Replaced by `BB_RSI_ADX_MAX` — the gate inverted (§3b). |
| `BB_RSI_CONFIRM_OUTSIDE_BAND` | Replaced by `BB_RSI_CONFIRM_ON_CLOSE` (§3a). |

Earlier removals still in force: **PSAR** (`BB_RSI_PSAR_*`, `BB_RSI_USE_SUPERTREND`, removed 2026-07-05); and the V4 set — tiered % profit-trail, time-stop, pause-override, BB squeeze, CPR-narrow, approach, body-ratio, trend filter, activity filter.

## 12. Status — NOT validated

V8 has never traded. It has an engine-level test suite covering entry direction, every guard, the divergence gate both ways, and the stop/trail phases, but **no paper session, no backtest and no replay have been run against it**. Treat every default here as a starting point, not a tuned value — in particular `BB_RSI_MIN_BAND_WIDTH_PTS(50)` and `BB_RSI_RSI_RANGE_MIN(30)`, which were chosen by reasoning about NIFTY 5-min scale, not measured. Collect clean post-rebuild sessions before tuning anything, and keep `LIVE_HARNESS_DRY_RUN=true` until Paper and Live agree on a recorded session via `/replay`.

---

*Reference, not a second source of truth — the code is authoritative. Update this file when the bb_rsi entry/exit logic or its defaults change.*

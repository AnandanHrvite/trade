# BB_RSI Strategy — Bollinger Bands + SuperTrend + RSI

*Redefined 2026-05-29 (trend-flip exit + profit lock). **PSAR removed 2026-07-05 — SuperTrend is now the sole trend source (V7).** Re-verified against the code 2026-07-26; entry/exit rules unchanged since 2026-07-05, additions this pass are §3a (confirmation candle, which was undocumented), §8 (stale-expiry block) and §8a (live-route parity).* Authoritative description of the **current** BB_RSI logic, transcribed from the code:
- Entry signal: [src/strategies/bb_rsi.js](src/strategies/bb_rsi.js) (`getSignal`) — shared by all three modes.
- Order/exit/trail management: [src/routes/bbRsiPaper.js](src/routes/bbRsiPaper.js) (paper is canonical) / [src/routes/bbRsiLive.js](src/routes/bbRsiLive.js). Backtest: [src/routes/bbRsiBacktest.js](src/routes/bbRsiBacktest.js). Replay drives the paper engine and inherits automatically.

All numeric values below are the **code defaults**; every one is overridable from the Settings UI (env var in parentheses).

Timeframe: **3 / 5 / 15-min** candles via the global `TRADE_RESOLUTION` (default 5) — shared by every strategy. BB and RSI use **close**. Broker: **Fyers** (live + all data); paper is simulated on the same tick feed.

---

## 1. Pre-conditions

| Check | Rule |
|-------|------|
| Warm-up | Need ≥ **30** candles before any signal (`max(BB_PERIOD+5, RSI_PERIOD+5, 30)`). |
| Trading window | New entries only between `BB_RSI_ENTRY_START` **09:21** and `BB_RSI_ENTRY_END` **14:30** IST. |
| SuperTrend ready | SuperTrend(`BB_RSI_SUPERTREND_PERIOD(10)` / `BB_RSI_SUPERTREND_MULT(3)`) must have a warmed-up trend value. |

## 2. Indicators computed each candle

- **Bollinger Bands** — period `BB_RSI_BB_PERIOD(20)`, std-dev `BB_RSI_BB_STDDEV(1)`, on close. (Std-dev **1** — tighter than the charting default of 2.)
- **RSI(14)** (close) — `BB_RSI_RSI_PERIOD`.
- **SuperTrend** — `BB_RSI_SUPERTREND_PERIOD(10)` / `BB_RSI_SUPERTREND_MULT(3)`, the sole trend source. Bullish when the line sits **below** close (trend = +1), bearish when it sits **above** close (trend = −1). It drives the directional confirm, the initial SL line, and the candle-close flip exit.
- **ADX(14)** — computed every candle for charting/logging; only gates entries when the ADX filter is on (§3).

## 3. Entry — all three conditions must be true (evaluated at candle close)

**CE (long call):**
- Candle **closes at/above the BB upper band** — `close ≥ BB.upper`
- **SuperTrend bullish** — line below close (trend = +1)
- `RSI > BB_RSI_RSI_CE_THRESHOLD(70)`
- **SuperTrend not too far** — `close − SuperTrend ≤ BB_RSI_MAX_ENTRY_SL_PTS(50)`
- → Initial SL = **SuperTrend value at entry**

**PE (long put):**
- Candle **closes at/below the BB lower band** — `close ≤ BB.lower`
- **SuperTrend bearish** — line above close (trend = −1)
- `RSI < BB_RSI_RSI_PE_THRESHOLD(40)`
- **SuperTrend not too far** — `SuperTrend − close ≤ BB_RSI_MAX_ENTRY_SL_PTS(50)`
- → Initial SL = **SuperTrend value at entry**

Just the two RSI keys — there are no overbought/oversold caps. The **far-line filter** (`BB_RSI_MAX_ENTRY_SL_PTS`, `0` disables) skips entries where a freshly-flipped SuperTrend line sits 100s of pts away (uncapped risk). Optional `BB_RSI_RSI_TURNING` (default off): also require RSI momentum to confirm (CE: RSI not falling vs prior bar; PE: not rising). **Optional ADX trend filter** (`BB_RSI_ADX_ENABLED`, default off): block **all** entries when `ADX(14) < BB_RSI_ADX_MIN(20)` — the strategy wins in trends and bleeds in chop, so this sits out ranging sessions. All valid signals enter at the `BB_RSI` strength tier.

### 3a. Confirmation candle (`BB_RSI_CONFIRM_CANDLE_ENABLED`, default **ON**)

The signal candle does **not** enter. With confirmation on (the shipped default), a fully-closed candle must satisfy every rule in §3 (the *signal candle*), and then the **next** candle must cross that signal candle's close — CE above / PE below — at which point entry fires **intra-bar on the cross**. This filters the one-candle false breakout. `BB_RSI_CONFIRM_OUTSIDE_BAND` moves the confirmation evaluation to the next bar with an additional band guard. Turning the toggle OFF restores the legacy behaviour: enter at the signal candle's close.

## 4. Stop loss & profit lock

The strategy is **SuperTrend-flip driven** for the trend exit, with a **profit lock** that banks small bb_rsi gains.

- **Initial SL = the SuperTrend value at entry** (no min/max clamp). At entry the SuperTrend line is always on the correct side and within `BB_RSI_MAX_ENTRY_SL_PTS`. It is used for risk sizing + display; it is **not** an intra-tick stop and does not trail.
- **Profit lock** (`BB_RSI_PROFIT_LOCK_TRIGGER_PTS(25)`, `0` disables; `BB_RSI_PROFIT_LOCK_PCT(50)`) — works in **spot points**, per-tick. Tracks the favourable spot move since entry (PE = entry−price, CE = price−entry). Once the **peak** favourable move reaches the trigger, exit as soon as it gives back below `PCT%` of the peak. The floor **ratchets up** with the peak (peak 100pts → lock 50pts; peak 200pts → lock 100pts at 50%). Points-based, so it works even when option P&L is unavailable (spot-proxy sessions). The per-tick **upside** exit.
- **Hard stop** (`BB_RSI_STOP_LOSS_PTS(30)`, `0` disables) — per-tick catastrophic loss cap; exit once the trade moves this many spot points **against** entry. Set **wide** so it never touches the normal small scalps — it only clips the deep adverse excursions on failed BB-break fades that would otherwise bleed to −100+ pts before the candle-close BB re-entry / SuperTrend flip fires. Points-based; arms the per-side SL cooldown.

## 5. Exit rules

1. **Profit lock (spot points)** — per tick, once peak favourable spot move ≥ `BB_RSI_PROFIT_LOCK_TRIGGER_PTS`, exit when the favourable move ≤ `BB_RSI_PROFIT_LOCK_PCT% × peak`. Ratchets for runners. The per-tick upside exit. Points-based — independent of option pricing.
2. **Hard stop (spot points)** — per tick, exit if the trade moves ≥ `BB_RSI_STOP_LOSS_PTS` against entry. Wide catastrophic loss cap; arms the SL cooldown. Points-based.
3. **BB re-entry (failed breakout)** — on candle close, if price has closed **back inside the band** the breakout that triggered the entry has failed → exit. CE: `close < BB.upper`; PE: `close > BB.lower`. Gated by `BB_RSI_BB_REENTRY_EXIT` (default on). Cuts loss bleed before the slower SuperTrend flip.
4. **SuperTrend flip** — on candle close, when the SuperTrend state reverses against the position (CE wants bullish, PE bearish), exit. Trend exit; handles runners beyond the lock.
5. **EOD square-off** at `TRADE_STOP_TIME(15:30)` IST (with an earlier backup just before).
6. **Daily kill-switch / max trades** — see risk guards.
7. Bid-ask spread guard shared via [src/utils/tradeGuards.js](src/utils/tradeGuards.js).

There is **no** break-even-to-entry snap, no percentage spot-trail, no time-stop, no pause-override, and no SuperTrend/prev-candle SL trail — the exits are the per-tick profit lock + hard stop, the candle-close BB re-entry, and the candle-close SuperTrend flip.

## 6. Same-side cooldown

After an **SL hit** on a side, new entries on **that side** are blocked for `BB_RSI_SL_PAUSE_CANDLES(3)` candles (`BB_RSI_PER_SIDE_PAUSE` on = per-side; off = global). Each consecutive SL after the 2nd adds `BB_RSI_CONSEC_SL_EXTRA_PAUSE(2)` extra candles.

## 7. Risk guards & filters

- `BB_RSI_MAX_DAILY_TRADES(30)` — entries per session.
- `BB_RSI_MAX_DAILY_LOSS(4000)` — daily kill-switch (INR).
- **VIX gate**: `BB_RSI_VIX_ENABLED` + `BB_RSI_VIX_MAX_ENTRY(20)` block entries above that VIX; `BB_RSI_VIX_STRONG_ONLY(16)` allows only STRONG signals above its level (bb_rsi-scoped).
- `BB_RSI_SLIPPAGE_PTS` — simulated slippage on entry & SL exit (paper/backtest).

## 8. Expiry & live gating

- `BB_RSI_EXPIRY_DAY_ONLY` — when on, only trade on NIFTY weekly expiry day.
- **Live order placement is double-gated**: `BB_RSI_ENABLED` **and** global `LIVE_HARNESS_DRY_RUN=false`, with `BB_RSI_LIVE_DRY_RUN` to keep BB_RSI simulated while others go live.
- **Stale expiry override blocks entry (2026-07-26).** `BB_RSI_OPTION_EXPIRY_OVERRIDE` falls back to the common `OPTION_EXPIRY_OVERRIDE`. A date is stale once past **15:30 IST on its own expiry day** (`instrument.isExpiryOverrideStale()`), so a contract still trades all through its expiry day. Previously the manual-override branch was the only one that returned its symbol **without** validating it via `getQuotes`, so a dead symbol reached the engine: BB_RSI entered anyway, logged `pnlMode: "spot proxy"`, and left `BB_RSI_OPT_STOP_PCT` inert (it needs an entry premium that never arrived) — i.e. **no option stop for the life of the position**. A stale override now returns `{ invalid: true, symbol: null }` plus the key to fix, and deliberately does **not** fall through to auto-detection. Sessions showing `pnlMode: "spot proxy"` + `no_data` option errors are a data hole, not a result.

## 8a. Live-route parity (2026-07-26) — no strategy logic changed

Three defects where `bbRsiLive` behaved differently from canonical paper:

1. **Session-teardown race.** `stopSession()` fired `squareOff()` un-awaited, then ran on to `saveBbRsiSession()` and `notifyDayReport()` while the sell was still at the broker — the saved session was missing its final trade and P&L (a ₹240→₹300 exit on qty 65 = **₹3,814** off the books). Now async and awaited, with `state.running` cleared first. Manual `/exit` had the same shape with no `.catch()`; it now awaits and returns 500 on broker failure.
2. **Unbounded broker wait.** Neither SDK sets an HTTP timeout, so the fix above could hang `/stop` and stall `gracefulShutdown`. [src/utils/boundedExit.js](src/utils/boundedExit.js) caps it at `LIVE_EXIT_WAIT_MS` (default **20000**, `0` opts out, malformed value warns and falls back rather than disabling the ceiling; read per call so Settings applies without a restart). The timeout **cancels nothing** — the alert reads "may still be in flight, verify the dashboard".
3. **`PORTFOLIO_MAX_DAILY_LOSS` was missing from every live route.** It was wired into the six paper routes only, so with the cap armed paper stopped entering while live kept trading. All ten routes now check it, at the same position in each gate chain. Block-only.

Covered by `npm run test:parity` (25 assertions, all mutation-tested).

## 9. Charts (paper status, live status, replay)

Plot these on **NIFTY 50 spot** at the same resolution (3 or 5-min) to mirror the engine:
- **Bollinger Bands** — period **20**, std-dev **1** (not the charting default of 2).
- **RSI(14)** — its own bottom scale, with the entry bands drawn at `BB_RSI_RSI_CE_THRESHOLD(70)` (top line) and `BB_RSI_RSI_PE_THRESHOLD(40)` (bottom line).
- **SuperTrend** (10 / 3) — a solid line coloured **green** when bullish (below price) / **red** when bearish (above price).

## 10. Logging

- Per-candle decision log: `[BB_RSI …] CE/PE: close vs BB band + SuperTrend<>close + RSI | SL`.
- Trade log JSONL: per-trade record carries BB band / RSI / SuperTrend at entry, MFE/MAE, charges, etc.
- Near-miss `filterAudit` tracks the three live checks only: BB break, SuperTrend side, RSI.

## 11. Removed vs earlier versions

**PSAR removed 2026-07-05.** Parabolic SAR (`BB_RSI_PSAR_STEP` / `BB_RSI_PSAR_MAX`) and the `BB_RSI_USE_SUPERTREND` toggle are gone — SuperTrend was previously an opt-in alternative and is now the only trend source (directional confirm, initial SL line, and candle-close flip exit). Their Settings fields have been removed.

Earlier (V4) removals: the tiered **% profit-trail** (`BB_RSI_TRAIL_START/PCT/TIERS/GRACE`), **time-stop** (`BB_RSI_TIME_STOP_*`), **pause-override** (`BB_RSI_PAUSE_OVERRIDE_*`), **BB squeeze** (`BB_RSI_BB_SQUEEZE_FILTER` / `BB_RSI_BB_MIN_WIDTH_PCT`), **CPR-narrow** (`BB_RSI_CPR_NARROW_PCT`), **approach** (`BB_RSI_REQUIRE_APPROACH`), **body-ratio** (`BB_RSI_MIN_BODY_RATIO`), **trend filter** (`BB_RSI_TREND_*`), and **activity filter** (`BB_RSI_ACTIVITY_*`) are all gone, with their Settings fields removed. Entry is now BB-break + SuperTrend-side + RSI + far-line filter; exit is the per-tick profit lock + candle-close SuperTrend flip.

---

*Reference, not a second source of truth — the code is authoritative. Update this file when the bb_rsi entry/exit logic or its defaults change.*

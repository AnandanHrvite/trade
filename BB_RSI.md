# BB_RSI Strategy — Bollinger Bands + PSAR + RSI

*Redefined 2026-05-29 (PSAR-flip exit + profit lock, V6.1).* Authoritative description of the **current** BB_RSI logic, transcribed from the code:
- Entry signal: [src/strategies/bb_rsi.js](src/strategies/bb_rsi.js) (`getSignal`) — shared by all three modes.
- Order/exit/trail management: [src/routes/bbRsiPaper.js](src/routes/bbRsiPaper.js) (paper is canonical) / [src/routes/bbRsiLive.js](src/routes/bbRsiLive.js). Backtest: [src/routes/bbRsiBacktest.js](src/routes/bbRsiBacktest.js). Replay drives the paper engine and inherits automatically.

All numeric values below are the **code defaults**; every one is overridable from the Settings UI (env var in parentheses).

Timeframe: **3 or 5-min** candles via `BB_RSI_RESOLUTION` (default 5). BB and RSI use **close**. Broker: **Fyers** (live + all data); paper is simulated on the same tick feed.

---

## 1. Pre-conditions

| Check | Rule |
|-------|------|
| Warm-up | Need ≥ **30** candles before any signal (`max(BB_PERIOD+5, RSI_PERIOD+5, 30)`). |
| Trading window | New entries only between `BB_RSI_ENTRY_START` **09:21** and `BB_RSI_ENTRY_END` **14:30** IST. |
| SAR ready | Parabolic SAR (step 0.02, max 0.2) must have a current value. |

## 2. Indicators computed each candle

- **Bollinger Bands** — period `BB_RSI_BB_PERIOD(20)`, std-dev `BB_RSI_BB_STDDEV(1)`, on close. (Std-dev **1** — tighter than the charting default of 2.)
- **RSI(14)** (close) — `BB_RSI_RSI_PERIOD`.
- **Parabolic SAR** — `BB_RSI_PSAR_STEP(0.02)` / `BB_RSI_PSAR_MAX(0.2)`. "Below close" = bullish, "above close" = bearish.
- **Optional SuperTrend** — `BB_RSI_USE_SUPERTREND` (default **off**). When on, SuperTrend(`BB_RSI_SUPERTREND_PERIOD(10)` / `BB_RSI_SUPERTREND_MULT(3)`) **replaces** PSAR as the directional confirm, the initial SL line, and the candle-close flip exit (mutually exclusive with PSAR; the chart shows whichever is active).

## 3. Entry — all three conditions must be true (evaluated at candle close)

**CE (long call):**
- Candle **closes at/above the BB upper band** — `close ≥ BB.upper`
- **PSAR below the close** — `SAR < close`
- `RSI > BB_RSI_RSI_CE_THRESHOLD(70)`
- **PSAR not too far** — `close − SAR ≤ BB_RSI_MAX_ENTRY_SL_PTS(50)`
- → Initial SL = **PSAR value at entry**

**PE (long put):**
- Candle **closes at/below the BB lower band** — `close ≤ BB.lower`
- **PSAR above the close** — `SAR > close`
- `RSI < BB_RSI_RSI_PE_THRESHOLD(40)`
- **PSAR not too far** — `SAR − close ≤ BB_RSI_MAX_ENTRY_SL_PTS(50)`
- → Initial SL = **PSAR value at entry**

Just the two RSI keys — there are no overbought/oversold caps. The **far-PSAR filter** (`BB_RSI_MAX_ENTRY_SL_PTS`, `0` disables) skips entries where a freshly-flipped SAR sits 100s of pts away (uncapped risk). Optional `BB_RSI_RSI_TURNING` (default off): also require RSI momentum to confirm (CE: RSI not falling vs prior bar; PE: not rising). **Optional ADX trend filter** (`BB_RSI_ADX_ENABLED`, default off): block **all** entries when `ADX(14) < BB_RSI_ADX_MIN(20)` — the strategy wins in trends and bleeds in chop, so this sits out ranging sessions. All valid signals enter at the `BB_RSI` strength tier.

## 4. Stop loss & profit lock

The strategy is **PSAR-flip driven** for the trend exit, with a **profit lock** that banks small bb_rsi gains.

- **Initial SL = the PSAR value at entry** (no min/max clamp). At entry PSAR is always on the correct side and within `BB_RSI_MAX_ENTRY_SL_PTS`. It is used for risk sizing + display; it is **not** an intra-tick stop and does not trail.
- **Profit lock** (`BB_RSI_PROFIT_LOCK_TRIGGER_PTS(25)`, `0` disables; `BB_RSI_PROFIT_LOCK_PCT(50)`) — works in **spot points**, per-tick. Tracks the favourable spot move since entry (PE = entry−price, CE = price−entry). Once the **peak** favourable move reaches the trigger, exit as soon as it gives back below `PCT%` of the peak. The floor **ratchets up** with the peak (peak 100pts → lock 50pts; peak 200pts → lock 100pts at 50%). Points-based, so it works even when option P&L is unavailable (spot-proxy sessions). The per-tick **upside** exit.
- **Hard stop** (`BB_RSI_STOP_LOSS_PTS(30)`, `0` disables) — per-tick catastrophic loss cap; exit once the trade moves this many spot points **against** entry. Set **wide** so it never touches the normal small scalps — it only clips the deep adverse excursions on failed BB-break fades that would otherwise bleed to −100+ pts before the candle-close BB re-entry / PSAR flip fires. Points-based; arms the per-side SL cooldown.

## 5. Exit rules

1. **Profit lock (spot points)** — per tick, once peak favourable spot move ≥ `BB_RSI_PROFIT_LOCK_TRIGGER_PTS`, exit when the favourable move ≤ `BB_RSI_PROFIT_LOCK_PCT% × peak`. Ratchets for runners. The per-tick upside exit. Points-based — independent of option pricing.
2. **Hard stop (spot points)** — per tick, exit if the trade moves ≥ `BB_RSI_STOP_LOSS_PTS` against entry. Wide catastrophic loss cap; arms the SL cooldown. Points-based.
3. **BB re-entry (failed breakout)** — on candle close, if price has closed **back inside the band** the breakout that triggered the entry has failed → exit. CE: `close < BB.upper`; PE: `close > BB.lower`. Gated by `BB_RSI_BB_REENTRY_EXIT` (default on). Cuts loss bleed before the slower PSAR flip.
4. **Trend flip** — on candle close, when the trend line crosses to the wrong side of price, exit (PSAR flip by default, or SuperTrend flip when `BB_RSI_USE_SUPERTREND` is on). Trend exit; handles runners beyond the lock.
5. **EOD square-off** at `TRADE_STOP_TIME(15:30)` IST (with an earlier backup just before).
6. **Daily kill-switch / max trades** — see risk guards.
7. Bid-ask spread guard shared via [src/utils/tradeGuards.js](src/utils/tradeGuards.js).

There is **no** break-even-to-entry snap, no percentage spot-trail, no time-stop, no pause-override, and no PSAR/prev-candle SL trail — the exits are the per-tick profit lock + hard stop, the candle-close BB re-entry, and the candle-close PSAR flip.

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

## 9. Charts (paper status, live status, replay)

Plot these on **NIFTY 50 spot** at the same resolution (3 or 5-min) to mirror the engine:
- **Bollinger Bands** — period **20**, std-dev **1** (not the charting default of 2).
- **RSI(14)** — its own bottom scale, with the entry bands drawn at `BB_RSI_RSI_CE_THRESHOLD(70)` (top line) and `BB_RSI_RSI_PE_THRESHOLD(40)` (bottom line).
- **Parabolic SAR** (0.02 / 0.2) — discrete **dots** (PSAR below candle confirms CE, above confirms PE).

## 10. Logging

- Per-candle decision log: `[BB_RSI …] CE/PE: close vs BB band + SAR<>close + RSI | SL`.
- Trade log JSONL: per-trade record carries BB band / RSI / SAR at entry, MFE/MAE, charges, etc.
- Near-miss `filterAudit` now tracks the three live checks only: BB break, PSAR side, RSI.

## 11. Removed vs the previous (V4) strategy

The tiered **% profit-trail** (`BB_RSI_TRAIL_START/PCT/TIERS/GRACE`), **time-stop** (`BB_RSI_TIME_STOP_*`), **pause-override** (`BB_RSI_PAUSE_OVERRIDE_*`), **BB squeeze** (`BB_RSI_BB_SQUEEZE_FILTER` / `BB_RSI_BB_MIN_WIDTH_PCT`), **CPR-narrow** (`BB_RSI_CPR_NARROW_PCT`), **approach** (`BB_RSI_REQUIRE_APPROACH`), **body-ratio** (`BB_RSI_MIN_BODY_RATIO`), **trend filter** (`BB_RSI_TREND_*`), and **activity filter** (`BB_RSI_ACTIVITY_*`) are all gone, with their Settings fields removed. Entry is now BB-break + PSAR-side + RSI + far-PSAR filter; exit is the per-tick profit lock + candle-close PSAR flip.

---

*Reference, not a second source of truth — the code is authoritative. Update this file when the bb_rsi entry/exit logic or its defaults change.*

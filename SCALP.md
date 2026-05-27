# SCALP Strategy — Bollinger Bands + PSAR + RSI

*Redefined 2026-05-28.* Authoritative description of the **current** Scalp logic, transcribed from the code:
- Entry signal: [src/strategies/scalp_bb_cpr.js](src/strategies/scalp_bb_cpr.js) (`getSignal`) — shared by all three modes.
- Order/exit/trail management: [src/routes/scalpPaper.js](src/routes/scalpPaper.js) (paper is canonical) / [src/routes/scalpLive.js](src/routes/scalpLive.js). Backtest: [src/routes/scalpBacktest.js](src/routes/scalpBacktest.js). Replay drives the paper engine and inherits automatically.

All numeric values below are the **code defaults**; every one is overridable from the Settings UI (env var in parentheses).

Timeframe: **3 or 5-min** candles via `SCALP_RESOLUTION` (default 5). BB and RSI use **close**. Broker: **Fyers** (live + all data); paper is simulated on the same tick feed.

---

## 1. Pre-conditions

| Check | Rule |
|-------|------|
| Warm-up | Need ≥ **30** candles before any signal (`max(BB_PERIOD+5, RSI_PERIOD+5, 30)`). |
| Trading window | New entries only between `SCALP_ENTRY_START` **09:21** and `SCALP_ENTRY_END` **14:30** IST. |
| SAR ready | Parabolic SAR (step 0.02, max 0.2) must have a current value. |

## 2. Indicators computed each candle

- **Bollinger Bands** — period `SCALP_BB_PERIOD(20)`, std-dev `SCALP_BB_STDDEV(1)`, on close. (Std-dev **1** — tighter than the charting default of 2.)
- **RSI(14)** (close) — `SCALP_RSI_PERIOD`.
- **Parabolic SAR** — `SCALP_PSAR_STEP(0.02)` / `SCALP_PSAR_MAX(0.2)`. "Below close" = bullish, "above close" = bearish.

## 3. Entry — all three conditions must be true (evaluated at candle close)

**CE (long call):**
- Candle **closes at/above the BB upper band** — `close ≥ BB.upper`
- **PSAR below the close** — `SAR < close`
- `RSI > SCALP_RSI_CE_THRESHOLD(62)` — and **not** `> SCALP_RSI_CE_MAX(78)` (overbought guard)
- → Initial SL = **previous candle's LOW**

**PE (long put):**
- Candle **closes at/below the BB lower band** — `close ≤ BB.lower`
- **PSAR above the close** — `SAR > close`
- `RSI < SCALP_RSI_PE_THRESHOLD(42)` — and **not** `< SCALP_RSI_PE_MIN(22)` (oversold guard)
- → Initial SL = **previous candle's HIGH**

Optional `SCALP_RSI_TURNING` (default off): also require RSI momentum to confirm (CE: RSI not falling vs prior bar; PE: not rising). All valid signals enter at the `SCALP` strength tier.

## 4. Stop loss & trailing

**`SCALP_SL_USE_SAR` (default off) picks the SL source for BOTH the initial SL and the trail:**

- **OFF — Prev Candle:** initial SL = the prior completed candle's **low (CE) / high (PE)**; the trail tightens SL to **each just-closed candle's low/high**. No PSAR-flip exit.
- **ON — SAR:** initial SL = the **PSAR value** at entry; the trail tightens SL toward **PSAR** (only when PSAR is on the favourable side); the **PSAR-flip exit** is active.
- Either way the initial distance is capped to `SCALP_MAX_SL_PTS(12)` and floored at `SCALP_MIN_SL_PTS(8)` from the close. (At entry PSAR is always on the correct side, since entry requires SAR below close for CE / above for PE.)
- **Break-even snap** (`SCALP_BREAKEVEN_TRIGGER_R(0.7)`, `0` disables) applies in **both** modes: once peak P&L ≥ trigger × initial risk, SL jumps to entry ± `SCALP_BREAKEVEN_OFFSET_PTS(1)`. Per-tick, tighten-only.
- All trailing is tighten-only — never loosens.

## 5. Exit rules

1. **SL hit** — `ltp ≤ SL` (CE) / `ltp ≥ SL` (PE), every tick. Source is labelled Prev Candle / PSAR / BreakEven.
2. **PSAR flip** — when PSAR crosses to the wrong side of price, exit immediately. **(SAR mode only.)**
3. **EOD square-off** at `TRADE_STOP_TIME(15:30)` IST (with an earlier backup just before).
4. **Daily kill-switch / max trades** — see risk guards.
5. Bid-ask spread guard shared via [src/utils/tradeGuards.js](src/utils/tradeGuards.js).

There is **no** percentage profit-trail, no time-stop, and no pause-override — the trail is the chosen source (prev-candle or PSAR) plus the break-even snap.

## 6. Same-side cooldown

After an **SL hit** on a side, new entries on **that side** are blocked for `SCALP_SL_PAUSE_CANDLES(3)` candles (`SCALP_PER_SIDE_PAUSE` on = per-side; off = global). Each consecutive SL after the 2nd adds `SCALP_CONSEC_SL_EXTRA_PAUSE(2)` extra candles.

## 7. Risk guards & filters

- `SCALP_MAX_DAILY_TRADES(30)` — entries per session.
- `SCALP_MAX_DAILY_LOSS(4000)` — daily kill-switch (INR).
- **VIX gate**: `SCALP_VIX_ENABLED` + `SCALP_VIX_MAX_ENTRY(20)` block entries above that VIX; `SCALP_VIX_STRONG_ONLY(16)` allows only STRONG signals above its level (scalp-scoped).
- `SCALP_SLIPPAGE_PTS` — simulated slippage on entry & SL exit (paper/backtest).

## 8. Expiry & live gating

- `SCALP_EXPIRY_DAY_ONLY` — when on, only trade on NIFTY weekly expiry day.
- **Live order placement is double-gated**: `SCALP_ENABLED` **and** global `LIVE_HARNESS_DRY_RUN=false`, with `SCALP_LIVE_DRY_RUN` to keep Scalp simulated while others go live.

## 9. Charts (paper status, live status, replay)

Plot these on **NIFTY 50 spot** at the same resolution (3 or 5-min) to mirror the engine:
- **Bollinger Bands** — period **20**, std-dev **1** (not the charting default of 2).
- **RSI(14)** — its own bottom scale, with the entry bands drawn at `SCALP_RSI_CE_THRESHOLD(62)` (top line) and `SCALP_RSI_PE_THRESHOLD(42)` (bottom line).
- **Parabolic SAR** (0.02 / 0.2) — discrete **dots** (PSAR below candle confirms CE, above confirms PE).

## 10. Logging

- Per-candle decision log: `[SCALP …] CE/PE: close vs BB band + SAR<>close + RSI | SL`.
- Trade log JSONL: per-trade record carries BB band / RSI / SAR at entry, MFE/MAE, charges, etc.
- Near-miss `filterAudit` now tracks the three live checks only: BB break, PSAR side, RSI.

## 11. Removed vs the previous (V4) strategy

The tiered **% profit-trail** (`SCALP_TRAIL_START/PCT/TIERS/GRACE`), **time-stop** (`SCALP_TIME_STOP_*`), **pause-override** (`SCALP_PAUSE_OVERRIDE_*`), **BB squeeze** (`SCALP_BB_SQUEEZE_FILTER` / `SCALP_BB_MIN_WIDTH_PCT`), **CPR-narrow** (`SCALP_CPR_NARROW_PCT`), **approach** (`SCALP_REQUIRE_APPROACH`), **body-ratio** (`SCALP_MIN_BODY_RATIO`), **trend filter** (`SCALP_TREND_*`), and **activity filter** (`SCALP_ACTIVITY_*`) are all gone, with their Settings fields removed. Entry is now BB-break + PSAR-side + RSI; exit is PSAR flip + PSAR/break-even trail.

---

*Reference, not a second source of truth — the code is authoritative. Update this file when the scalp entry/exit logic or its defaults change.*

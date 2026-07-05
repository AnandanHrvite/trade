# EMA_RSI_ST Strategy — EMA21 + RSI + SAR

*Redefined 2026-05-27.* Authoritative description of the **current** EMA_RSI_ST logic, transcribed from the code:
- Entry signal: [src/strategies/strategy1_sar_ema_rsi.js](src/strategies/strategy1_sar_ema_rsi.js) (`getSignal`) — shared by all 5 modes.
- Order/exit/trail management: [src/routes/emaRsiStPaper.js](src/routes/emaRsiStPaper.js) (paper is canonical) / [src/routes/emaRsiStLive.js](src/routes/emaRsiStLive.js). Backtest: [src/services/backtestEngine.js](src/services/backtestEngine.js). Replay + Live Harness drive the paper/live engines and inherit automatically.

All numeric values below are the **code defaults**; every one is overridable from the Settings UI (env var in parentheses).

Timeframe: **3 / 5 / 15-min** candles via `TRADE_RESOLUTION` (default 5). The logic is resolution-agnostic. EMA uses **OHLC4**, RSI uses close. Broker: **Zerodha** (live), simulated (paper), Fyers (data).

---

## 1. Pre-conditions

| Check | Rule |
|-------|------|
| Warm-up | Need ≥ **30** candles before any signal (EMA21 + RSI(14) + SAR stabilise). |
| Trading window | Entries only between `TRADE_ENTRY_START` **09:30** and `TRADE_ENTRY_END` **14:00** IST. |
| SAR ready | Parabolic SAR (step 0.02, max 0.2) must have a current value. |

## 2. Indicators computed each candle

- **EMA21** (OHLC4)
- **RSI(14)** (close)
- **Parabolic SAR** — `trend=1` dots **below** price (bullish), `trend=-1` dots **above** price (bearish)

(EMA9, EMA30, ADX are no longer used.)

## 3. Entry — all three conditions must be true

Evaluated on **every tick while flat** (intra-candle); the entry fires whether the candle is *already* on the correct side of EMA21 or *crossing* it now.

**CE (long call):**
- `RSI(14) > RSI_CE_MIN(52)` **and** `RSI < RSI_CE_MAX(80)` (overbought guard)
- Price **at or above** EMA21 — `candle.high ≥ EMA21`
- SAR **below** the candle — `SAR.trend = 1`
- → Initial SL = **previous candle's LOW**

**PE (long put):**
- `RSI(14) < RSI_PE_MAX(48)` **and** `RSI > RSI_PE_MIN(20)` (oversold guard)
- Price **at or below** EMA21 — `candle.low ≤ EMA21`
- SAR **above** the candle — `SAR.trend = -1`
- → Initial SL = **previous candle's HIGH**

There is no strength tier — all valid signals enter intra-candle at the tick price.

## 4. Stop loss & trailing (previous-candle trailing stop)

- **Initial SL** = the prior completed candle's **low (CE) / high (PE)**, used as-is (no hybrid cap, no floor).
- **Trail**: at each candle close, tighten the SL to **that just-closed candle's** low (CE) / high (PE). Tighten-only — never loosens. Enforced intra-candle (tick-by-tick) during the next bar; in live this is also pushed to the broker hard-SL.
- **Breakeven**: once price is **+`BREAKEVEN_PTS(25)`pt** in favour, SL jumps to entry (tighten-only).

## 5. Exit rules

1. **Prev-candle SL hit** — `ltp ≤ SL` (CE) / `ltp ≥ SL` (PE), every tick.
2. **Option-premium stop** — exit if option LTP `≤ entryLtp × (1 − OPT_STOP_PCT(0.25))`. (In backtest, approximated as an equivalent adverse spot move since there is no live premium.)
3. **Opposite signal** — CE position + BUY_PE → exit (and vice-versa).
4. **Exit before day close** — square off any open position at/after `EMA_RSI_ST_EOD_EXIT_TIME(15:15)` IST, ahead of the auto-stop.
5. **EOD auto-stop** at `TRADE_STOP_TIME(15:30)` — squares off and stops the engine.
6. **Time-stop** — flat trade bleeding theta is closed via `tradeGuards.checkTimeStop`.

## 6. Same-side cooldown

After an **SL hit or option-stop** on a side, new entries on **that side** are blocked for `EMA_RSI_ST_SL_PAUSE_CANDLES(3)` candles (per-side; the other side is free). `0` disables it.

## 7. Risk guards & filters

- `MAX_DAILY_TRADES(6)` — entries per session (enforced in paper, live, and backtest).
- `MAX_DAILY_LOSS(5000)` — daily kill-switch (also latched on 3 consecutive losses).
- **VIX gate**: `VIX_FILTER_ENABLED` + `VIX_MAX_ENTRY(20)` block entries above that VIX (EMA_RSI_ST-scoped).
- Bid-ask spread / time-stop shared via [src/utils/tradeGuards.js](src/utils/tradeGuards.js).

## 8. Expiry & live gating

- **0DTE refusal**: live/paper `/start` is blocked when the configured expiry == today (gamma risk). **Replay bypasses this** (`force=1`) — a historical replay must not be aborted by a live-trading safety gate.
- `TRADE_EXPIRY_DAY_ONLY` — when on, only trade on NIFTY expiry day.
- `EMA_RSI_ST_OPTION_EXPIRY_OVERRIDE` / `EMA_RSI_ST_OPTION_EXPIRY_TYPE` let EMA_RSI_ST run a different expiry from the other strategies; blank inherits the common expiry.
- **Live order placement is double-gated**: `EMA_RSI_ST_LIVE_ENABLED` **and** global `LIVE_HARNESS_DRY_RUN=false`, with a per-strategy `EMA_RSI_ST_LIVE_DRY_RUN` override to keep EMA_RSI_ST simulated while others go live.

## 9. Charts (paper status, live status, replay)

Every swing chart overlays the indicators the strategy actually decides on:
- **EMA21** (OHLC4) — solid orange line.
- **Parabolic SAR** (0.02/0.2) — discrete **dots** (line hidden, point-markers only).
- **RSI(14)** — its own bottom price-scale, with dashed level lines at `RSI_CE_MIN` (green "CE")
  and `RSI_PE_MAX` (red "PE") so the entry bands are visible. (Overbought/oversold caps
  `RSI_CE_MAX`/`RSI_PE_MIN` are enforced in code; the visible band lines are the momentum thresholds.)

Data: `GET /ema_rsi_st-paper/status/chart-data` and `/ema_rsi_st-live/status/chart-data` return
`{ candles, markers, ema21, sar, rsi, rsiCeMin, rsiPeMax, stopLoss, entryPrice }`. Replay harvests
the same contract. (Backtest uses Chart.js equity curves, not a candlestick chart — no overlays.)

## 10. Logging

All swing logs reflect this strategy (no EMA9/ADX/STRONG-MARGINAL anywhere):
- Per-candle decision log: `[STRAT … ] EMA21=… | RSI=… | SAR=…(BULL/BEAR) | C/H/L`.
- Candle-close summary (paper/live): `EMA21=… | RSI=… | SAR=…(trend)`.
- Skip log ([skipLogger](src/utils/skipLogger.js)): records `ema21 / rsi / sar / sarTrend` + the block reason.
- Trade log ([tradeLogger](src/utils/tradeLogger.js)) JSONL: per-trade record carries `rsiAtEntry / ema21AtEntry / sarAtEntry / sarTrend`, MFE/MAE, charges, etc.
- Startup banner: entry rule + stop/exit + risk-guard summary (see emaRsiStPaper/emaRsiStLive `/start`).

## 11. Removed vs the previous strategy

EMA9 touch, EMA30 trend gate, ADX filter, candle-body filter, min/max SAR-distance gates, Logic-3 SAR-lag overrides, STRONG/MARGINAL strength tiers, tiered (T1/T2/T3) trailing, hybrid initial-SL cap (max/min pts), the optional prev-candle *structural* trail, the 50% candle rule, and the near-miss "N/8 filter audit" log are all gone. Their Settings fields were removed.

---

*Reference, not a second source of truth — the code is authoritative. Update this file when the swing entry/exit logic or its defaults change.*

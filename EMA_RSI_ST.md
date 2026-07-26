# EMA_RSI_ST Strategy — EMA alignment + RSI + SuperTrend

*Entry redefined 2026-05-31. **Parabolic SAR stripped 2026-06-12 — SuperTrend is the only trend source.** Fully rewritten 2026-07-26: this file previously still described the SAR/EMA21 entry, which has not existed since June.* Authoritative description of the **current** EMA_RSI_ST logic, transcribed from the code:

- Entry signal: [src/strategies/strategy1_sar_ema_rsi.js](src/strategies/strategy1_sar_ema_rsi.js) (`getSignal`) — shared by all modes. (The filename is historical; there is no SAR left in it.)
- Order/exit/trail management: [src/routes/emaRsiStPaper.js](src/routes/emaRsiStPaper.js) (**paper is canonical**) / [src/routes/emaRsiStLive.js](src/routes/emaRsiStLive.js). Backtest: [src/services/backtestEngine.js](src/services/backtestEngine.js). Replay + Live Harness drive the paper engine and inherit automatically — so every paper defect is a real-money defect.

Two default sets exist and they differ. Values below are the **code defaults** (`process.env.X || "…"`); where the shipped **Settings** default differs it is called out. Read `settings_snapshot` in a day's JSONL to know what actually ran.

Timeframe: **3 / 5 / 15-min** candles via `TRADE_RESOLUTION` (default 5); the logic is resolution-agnostic. Entry EMAs use **close**; EMA21 (used only by the trail) uses **OHLC4**; RSI uses close. Broker: **Zerodha** (live), simulated (paper), **Fyers** (all data).

---

## 1. Pre-conditions

| Check | Rule |
|-------|------|
| Warm-up | `max(EMA_SLOW, 30) + 5` candles — **55** at the default EMA50. |
| Trading window | New entries only between `TRADE_ENTRY_START` **09:30** and `TRADE_ENTRY_END` **14:00** IST. Exported as `isInTradingWindow()` so the engines gate the *confirmation* candle's bar on the same rule instead of re-parsing it. |
| Indicators ready | EMA fast/slow, RSI(14) and SuperTrend must all have current values (plus EMA9 when the triple stack is on). |

## 2. Indicators computed each candle

- **EMA20** (close) — `EMA_RSI_ST_EMA_FAST(20)`
- **EMA50** (close) — `EMA_RSI_ST_EMA_SLOW(50)`
- **EMA9** (close) — `EMA_RSI_ST_EMA_FASTEST(9)`, computed **only** when the triple-stack toggle is ON
- **RSI(14)** (close)
- **SuperTrend** — `EMA_RSI_ST_SUPERTREND_PERIOD(10)` / `EMA_RSI_ST_SUPERTREND_MULT(3)`, the sole directional gate
- **EMA21** (OHLC4) — computed but **not** an entry input; used only by the `ema` SL trail and the trade-record snapshot

## 3. Entry — four gates, all must be true

Evaluated on **every tick while flat** (intra-candle). `signalStrength` is always `STRONG`; the field is retained only so the VIX gate's call shape is unchanged.

**CE (long call):**
1. **EMA alignment bullish** — 2-EMA (default): `EMA20 > EMA50`. Triple-stack (opt-in, `EMA_RSI_ST_EMA_TRIPLE_STACK_ENABLED`, default off): `EMA9 > EMA20 > EMA50`.
2. **RSI band** — `RSI_CE_MIN(52) < RSI < RSI_CE_MAX(80)`. The upper bound is an overbought guard against chasing exhausted moves.
3. **SuperTrend bullish** — `trend === 1` (line below price).
4. **Close beyond the base EMA** — `EMA_RSI_ST_CLOSE_BEYOND_EMA_ENABLED`, **default ON**: the signal candle's `close` must be **above** the base EMA, where base = EMA9 when the triple stack is on, else EMA20. Gates 1–3 only check EMA *ordering*; without this the strategy buys CE into dips that close below the fast EMA while the lines stay stacked from an earlier move (the 23-Jun midday-chop false breakouts entered 3–9 pts *below* EMA9).
→ SL seed = **previous completed candle's LOW**.

**PE (long put):** exact mirror — `EMA20 < EMA50` (or `EMA9 < EMA20 < EMA50`), `RSI_PE_MIN(20) < RSI < RSI_PE_MAX(48)`, SuperTrend bearish, close **below** the base EMA. SL seed = **previous candle's HIGH**.

### 3a. Confirmation candle (`EMA_RSI_ST_CONFIRM_CANDLE_ENABLED`, default **ON**)

The signal candle does not enter. A fully-closed candle must satisfy all four gates (the *signal candle*), then the **next** candle must cross that signal candle's close — CE above / PE below — and entry fires intra-bar on the cross. The engines enforce `isInTradingWindow()` on the confirmation bar too. OFF restores the legacy behaviour (enter at the signal candle's close).

## 4. Stop loss & trailing

- **Initial SL** — the prior completed candle's low (CE) / high (PE), used as-is. No hybrid cap, no floor.
- **Trail** — at each candle close the SL is set to the current **EMA21** (OHLC4), tighten-only. Enforced tick-by-tick during the next bar; in live it is also pushed to the broker hard-SL.
- **Candle-trail overlay** — `EMA_RSI_ST_CANDLE_TRAIL_ENABLED` (code **false** / Settings **true**) / `_BARS` (**3**): also compute the N-bar low (CE) / high (PE) and use whichever of the two levels is **tighter** (higher for CE, lower for PE). Tighten-only either way.
- **Breakeven** — `EMA_RSI_ST_BREAKEVEN_ENABLED` (**false**) / `EMA_RSI_ST_BREAKEVEN_PTS(25)`: once the trade is that far in favour on spot at a candle close, raise the stop to entry. Tighten-only, so it never loosens a deeper trail. Measured at candle close so paper and the candle-based backtest match.
- `EMA_RSI_ST_SL_MODE` — code default **`ema`**. The only thing `candle` still switches on is the legacy **time-stop** (`tradeGuards.checkTimeStop`); at the shipped `ema` setting the time-stop is **inert** and the EMA21 trail owns the SL entirely.

## 5. Exit rules

1. **SL hit** — every tick, `ltp ≤ SL` (CE) / `ltp ≥ SL` (PE).
2. **Points stop** — `EMA_RSI_ST_STOP_LOSS_PTS` (Settings default **25**, `0` = off): exit once spot moves this many points against entry.
3. **Option-premium stop** — `OPT_STOP_PCT` (code **0.15** / Settings **0.25**): exit if option LTP `≤ entryLtp × (1 − pct)`. Requires a real entry premium — see §5a. Approximated as an equivalent adverse spot move in backtest.
4. **Negative-candle stop** — `EMA_RSI_ST_NEG_CANDLE_LIMIT(2)`: cut a trade still in the red after N completed candles. Asymmetric on purpose — winners ride the trail, losers don't bleed across the chop. Measured on option premium, falling back to spot move. `0` = off.
5. **EMA21 touch-back** — on candle close, a candle whose range spans EMA21 (`low ≤ EMA21 ≤ high`) ends the trade. Belongs to the bar that owns the position, so a fresh entry isn't shaken out by its own bar.
6. **Opposite signal** — holding CE and a fresh BUY_PE appears (or vice-versa) → exit.
7. **Exit before close** — `EMA_RSI_ST_EOD_EXIT_TIME(15:15)` IST.
8. **EOD auto-stop** at `TRADE_STOP_TIME(15:30)` — squares off and stops the engine.
9. **Bid-ask spread guard** — shared via [src/utils/tradeGuards.js](src/utils/tradeGuards.js). The **time-stop** in the same file only runs when `EMA_RSI_ST_SL_MODE=candle`, so at the shipped default it never fires.

### 5a. Spot must never be booked as a premium (fixed 2026-07-26)

The 10-second option-poll fallback wrote **spot** (~₹23,800) into `position.optionEntryLtp`, which every downstream reader treats as a **premium** (~₹180). The 25% option stop then evaluated `182 <= 17,850 → true` and force-closed the trade ~1s after the real premium arrived; `simulateSell` booked `(182 − 23,800) × 65 = −₹15,35,170`, instantly latching `MAX_DAILY_LOSS`. The field is now left **null**, so the designed spot-proxy P&L mode applies — and in live this resurrects `placeHardSL()`, which is only reachable from the two `if (!optionEntryLtp)` branches the fake value was killing. **Any historical trade with a loss of that shape is a recording artefact, not a result.**

## 6. Cooldowns & the streak breaker

- **Same-side pause** — `EMA_RSI_ST_SL_PAUSE_CANDLES` (code 3 / Settings **2**): after an SL or option-stop on a side, block that side for N candles. `0` disables.
- **Opposite-side (flip) cooldown** — `EMA_RSI_ST_OPPOSITE_SIDE_COOLDOWN_ENABLED` (**on**) / `_CANDLES` (code 3 / Settings **2**): after a stop-type exit, block flipping to the other side. A normal opposite-signal or EOD exit does **not** arm it.
- **Consecutive-loss breaker** — `EMA_RSI_ST_MAX_CONSEC_LOSSES` (**0 = OFF**): halt entries for the session after N straight losses; any winner resets the count.

  **Fixed 2026-07-26:** a second, legacy streak rule paused entries at a hardcoded **3** and ignored this key entirely, so a strategy with the breaker explicitly disabled still froze for 20 minutes after three ₹500 losers — with the day's ₹1,500 well inside `MAX_DAILY_LOSS`. The Loss Streak card compounded it by rendering "2 / 3 — 1 more = pause" against a breaker that was off. Both mechanisms now read the same key in `emaRsiStPaper`, `emaRsiStLive`, `ema9vwapPaper` and `backtestEngine`; the card shows the configured limit or "breaker OFF", never an invented denominator. Asserted in `tests/configFidelity.regression.js`.

## 7. Risk guards & filters

- `MAX_DAILY_TRADES` — code 20 / Settings **5**. Enforced in paper, live and backtest.
- `MAX_DAILY_LOSS` — code 5000 / Settings **3000**. In live this latch now **survives a restart** (it re-reads today's booked live loss instead of resetting the budget to zero); skipped during replay.
- `PORTFOLIO_MAX_DAILY_LOSS` — cross-strategy cap, `0` = off. Now applied in the **live** routes too (see §8a).
- **VIX gate** — `VIX_FILTER_ENABLED` + `VIX_MAX_ENTRY(20)`. These are the **global** keys; EMA9_VWAP shares them, so changing them here changes that strategy too.
- `EMA_RSI_ST_OI_ENABLED` — optional OI-buildup gate (live only, default off).

## 8. Expiry & live gating

- **0DTE refusal** — `/start` is blocked when the configured expiry is today (gamma risk). **Replay bypasses this** (`force=1`).
- `TRADE_EXPIRY_DAY_ONLY` — when on, only trade on NIFTY expiry day.
- `EMA_RSI_ST_OPTION_EXPIRY_OVERRIDE` / `_TYPE` — run a different expiry from the other strategies; blank falls back to the common `OPTION_EXPIRY_OVERRIDE`, then to auto-detection.
- **Stale override now blocks entry (2026-07-26).** Staleness has one definition, `instrument.isExpiryOverrideStale()`: past **15:30 IST on the expiry day itself**, so a contract still trades all through its own expiry day. The manual-override branch of `validateAndGetOptionSymbol` was the only path that returned its symbol **without** validating it via `getQuotes`, so a five-day-dead symbol reached the engines — ORB and TREND_PB blocked the entry, but EMA_RSI_ST and BB_RSI **entered anyway**, logged `pnlMode: "spot proxy"`, and left `OPT_STOP_PCT` inert (it needs an entry premium that never arrived), i.e. **no option stop for the life of the position**. A stale override now returns `{ invalid: true, symbol: null }` plus the key to fix, and deliberately does **not** fall through to auto-detection — a different expiry changes premium, theta and therefore risk, which is the operator's call. The dashboard banner checks all six per-mode keys, not just the common one; both `/manualEntry` routes now 409 instead of entering on `symbol=null`.
- **Live order placement is double-gated**: `EMA_RSI_ST_LIVE_ENABLED` **and** global `LIVE_HARNESS_DRY_RUN=false`, with `EMA_RSI_ST_LIVE_DRY_RUN` to keep this strategy simulated while others go live.

### 8a. Live-route parity (2026-07-26) — no strategy logic changed

- `stopSession()` called `squareOff()` un-awaited inside a `try/catch` that could not catch anything (an async rejection is not a thrown error) and returned before the order went out, so `gracefulShutdown` headed for `process.exit` with a real Zerodha position possibly still open. Now awaited. (No P&L was lost here — unlike BB_RSI/PA, this route has no session save in `stopSession()`.)
- The wait is bounded by [src/utils/boundedExit.js](src/utils/boundedExit.js) at `LIVE_EXIT_WAIT_MS` (default **20000**; `0` opts out; a malformed value warns and falls back rather than removing the ceiling; read per call so Settings applies without a restart). The ceiling **cancels nothing** — the alert reads "may still be in flight, verify the dashboard".
- `PORTFOLIO_MAX_DAILY_LOSS` was missing from every live route while being enforced in all six paper routes — paper stopped entering while live kept trading. Now applied in both the candle-close and intra-tick gate chains.
- The EOD auto-stop used a BB_RSI + EMA9VWAP-only socket guard at three sites and killed the **shared** Fyers feed under running PA/ORB/TREND_PB. Fixed.

Covered by `npm run test:parity` and `npm run test:config`.

## 9. Charts (paper status, live status, replay)

Overlay what the strategy actually decides on:
- **EMA20** and **EMA50** (close) — the alignment gate. **EMA9** only when the triple stack is on.
- **SuperTrend (10, 3)** — solid line, green when bullish (below price) / red when bearish.
- **EMA21** (OHLC4) — the trail line, not an entry input.
- **RSI(14)** — own bottom scale with dashed lines at `RSI_CE_MIN(52)` and `RSI_PE_MAX(48)`. The `RSI_CE_MAX(80)` / `RSI_PE_MIN(20)` guards are enforced in code; the visible bands are the momentum thresholds.

Data: `GET /ema_rsi_st-paper/status/chart-data` and `/ema_rsi_st-live/status/chart-data`. Replay harvests the same contract. (Backtest uses Chart.js equity curves — no candlestick overlays.)

## 10. Logging

- Per-candle decision log: `[STRAT …] EMA20=… EMA50=…(20>50) | RSI=… | ST=…(BULL/BEAR) | C=…`
- Signal log: `🟢 BUY_CE — EMA20>50 | RSI 61.2>52 | ST GREEN | C 24352>EMA20 24330.1 | SL(prevLow)=24340`
- Skip log ([skipLogger](src/utils/skipLogger.js)) records which of the four gates failed, with numbers.
- Trade log ([tradeLogger](src/utils/tradeLogger.js)) JSONL carries `rsiAtEntry / ema20 / ema50 / ema9 / ema21 / supertrend / stTrend`, MFE/MAE, charges.

## 11. Removed vs earlier versions

**Parabolic SAR removed 2026-06-12** — SuperTrend is the only trend source. Also gone: the EMA9-**touch** entry, EMA30 trend gate, ADX filter, candle-body filter, min/max SAR-distance gates, Logic-3 SAR-lag overrides, STRONG/MARGINAL strength tiers, tiered (T1/T2/T3) trailing, the hybrid initial-SL cap, the 50% candle rule, and the "N/8 filter audit" near-miss log. Their Settings fields were removed.

---

*Reference, not a second source of truth — the code is authoritative. Update this file when the entry/exit logic or its defaults change.*

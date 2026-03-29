# CHANGELOG — Palani Andawar Trading App

---

## v-scalp — Scalp Mode + Performance (2026-03-29)

### Summary

Added a complete **parallel scalping system** (3-min candles, Fyers orders) that runs independently alongside the existing 15-min Live Trade (Zerodha). Includes scalp backtest, paper trade, and live trade — all controllable from the Settings UI. Also applied hot-path performance optimizations to `paperTrade.js`.

---

### New Files

| File | Purpose |
|------|---------|
| `src/strategies/scalp_ema9_rsi.js` | Scalp strategy — EMA9 OHLC4 cross + close confirmation + RSI momentum |
| `src/services/fyersBroker.js` | Fyers order placement (place_order, get_positions, cancel, exit) |
| `src/routes/scalp.js` | Scalp live trade — real Fyers orders on 3-min candles |
| `src/routes/scalpPaper.js` | Scalp paper trade — simulated on live data |
| `src/routes/scalpBacktest.js` | Scalp backtest — historical 3-min candle testing |

### Scalp Strategy: EMA9 + RSI (3-min)

**Entry (CE):**
1. Price crosses above EMA9 (OHLC4) AND candle closes above EMA9 (double confirmation)
2. RSI(14) > 55 AND rising (current > previous)
3. Candle body is green and >= 5 pts

**Entry (PE):** Mirror — close below EMA9, RSI < 45 and falling, red body >= 5pt

**Exit (priority order):**
1. Target hit (configurable, default 18pt)
2. Stop loss hit (configurable, default 12pt)
3. Trailing SL (8pt gap after 10pt profit)
4. RSI reversal (RSI crosses 50 against position)
5. Time stop (4 candles = 12 min — avoids dead trades)
6. EOD square-off at 3:20 PM

**What was deliberately excluded from scalp:**
- No SAR — too laggy on 3-min, creates late entries
- No 50% candle rule — swing concept, not applicable to scalping
- ADX optional (disabled by default) — needs many candles to warm up

---

### Modified Files

| File | Change |
|------|--------|
| `src/utils/socketManager.js` | Added `addCallback()`, `removeCallback()`, `isRunning()` — ticks fan out to all registered modes |
| `src/utils/sharedSocketState.js` | Added scalp mode tracking (`setScalpActive`, `clearScalp`, `canStart`) + mutual exclusion rules |
| `src/utils/sharedNav.js` | Added Scalp BT / Scalp Paper / Scalp Live to sidebar + LIVE/ON badges for scalp modes |
| `src/routes/trade.js` | `socketManager.stop()` now checks `isScalpActive()` before killing socket (2 locations) |
| `src/routes/paperTrade.js` | Same socket-stop safety (3 locations) + performance optimizations (see below) |
| `src/routes/settings.js` | Added "Scalp Mode" section (15 configurable fields) + keys in IMMEDIATE/SESSION sets |
| `src/app.js` | Registered 3 scalp routes + OPEN_PATHS + dashboard scalp card + top-bar scalp badge |
| `.env` | Added 15 `SCALP_*` environment variables (all defaults safe, `SCALP_ENABLED=false`) |
| `README.md` | Full rewrite with architecture, all modes, config reference |

---

### How Parallel Modes Work

```
Live Trade (Zerodha, 15-min)    ──┐
                                  ├── Same Fyers WebSocket (singleton)
Scalp Live (Fyers, 3-min)      ──┘    socketManager fans ticks to both

Each mode has:
- Own state object (tradeState vs scalpState)
- Own candle builder (15-min vs 3-min buckets)
- Own strategy (SAR+EMA+RSI vs EMA cross+RSI)
- Own broker (Zerodha vs Fyers)
- Own risk controls (separate MAX_DAILY_LOSS, MAX_TRADES)
- Own session persistence (live_trades.json vs scalp_live_trades.json)
```

**Socket lifecycle:**
- Primary mode (Live/Paper) owns socket start/stop
- Scalp piggybacks via `addCallback()` — receives same ticks
- When primary stops, socket stays alive if scalp is still running
- When scalp stops, it only kills socket if no primary mode is active

---

### Performance Optimizations — `paperTrade.js`

| Location | Issue | Fix | Impact |
|----------|-------|-----|--------|
| `onTick` L1035 | `istNow()` calls `toLocaleString()` (ICU) on every tick (150/min) | `Date.now()` — raw ms, formatted only on display | ~150 ICU calls/min eliminated |
| `getMinBucket` L185 | `new Date()` + `setMinutes()` on every tick | Pure integer math: `Math.floor(ms / resMs) * resMs` | ~150 Date allocations/min eliminated |
| `onCandleClose` L877 | EOD check: `new Date(toLocaleString())` — double Date + ICU | `getISTMinutes()` — integer arithmetic only | 1 ICU call per candle eliminated |
| `_optionPollTick` L377 | `parseFloat(process.env.OPT_STOP_PCT)` on every option poll (1/sec) | Cached as `_OPT_STOP_PCT` at module load (3 sites fixed) | ~60 env reads/min eliminated |
| `/status/data` L1914 | `[...ptState.log].reverse()` copies 2000 entries every 2s | Slice last 100 then reverse | ~1900 fewer elements per poll |
| `/status/data` L1898 | `trades.map()` rebuilds objects on every 2s poll | Cached with count check — only rebuilds on new trade | map() eliminated on ~99% of polls |

**Net on t2.micro:** ~450 fewer allocations/min in tick handler, eliminated repeated env reads and array copies in poll endpoints.

---

### Bug Fix — `_fiftyPctPauseUntil` not reset on session start

**File:** `src/routes/paperTrade.js`

**Before:** The 50%-rule entry pause from a previous session was not explicitly cleared when starting a new session. If the server wasn't restarted between sessions, the pause could theoretically carry over (harmless in practice since timestamps expire, but incorrect).

**After:** `ptState._fiftyPctPauseUntil = null` added to session reset block.

---

### Scalp .env Variables (all added)

```env
SCALP_ENABLED=false           # Master switch — must be true for live orders
SCALP_RESOLUTION=3            # Candle size (1/2/3/5 min)
SCALP_SL_PTS=12               # Stop loss distance from entry (pts)
SCALP_TARGET_PTS=18           # Target distance from entry (pts)
SCALP_TRAIL_GAP=8             # Trail gap behind best price (pts)
SCALP_TRAIL_AFTER=10          # Activate trail after N pts profit
SCALP_TIME_STOP_CANDLES=4     # Exit if no target within N candles
SCALP_MAX_DAILY_TRADES=30     # Daily entry cap
SCALP_MAX_DAILY_LOSS=2000     # Kill-switch (INR)
SCALP_SL_PAUSE_CANDLES=2      # Pause entries after SL hit
SCALP_RSI_CE_MIN=55           # Min RSI for CE entry
SCALP_RSI_PE_MAX=45           # Max RSI for PE entry
SCALP_MIN_BODY=5              # Min candle body (pts)
SCALP_ADX_ENABLED=false       # Optional ADX trend filter
SCALP_ADX_MIN=20              # ADX threshold (if enabled)
```

---

### Dashboard Changes

- New "Scalp Mode" card showing strategy config, broker, limits + links to Paper/Live/Backtest
- Top-bar shows "SCALP LIVE" badge when scalp live is active
- Sidebar shows LIVE badge on Scalp Live, ON badge on Scalp Paper when running
- Dashboard polls `/scalp/status/data` and `/scalp-paper/status/data` every 4s

---

### Zero Changes to Core Logic

These files were **not modified** (logic untouched):
- `src/strategies/strategy1_sar_ema_rsi.js` — main strategy
- `src/services/zerodhaBroker.js` — Zerodha orders
- `src/services/backtestEngine.js` — backtest engine
- `src/config/fyers.js` — Fyers auth
- `src/config/instrument.js` — strike/expiry calc

---

## v-final-2 — Trading Start Time Adjustment (2026-03-27)

### Summary
Adjusted trading start time from 9:45 AM to 9:30 AM IST for 15-minute candle strategy.
This allows earlier entry opportunities while maintaining indicator stability.

---

### Change — Trading Window Start Time

**File:** `src/strategies/strategy1_sar_ema_rsi.js`

**Before:** Trading window started at 9:45 AM IST (`totalMin < 585`)
**After:** Trading window starts at 9:30 AM IST (`totalMin < 570`)

**Why it matters:** 
- Market opens at 9:15 AM IST
- By 9:30 AM, one complete 15-min candle (9:15-9:30) has formed
- Pre-loaded historical data (99 candles) ensures all indicators (SAR, EMA9, RSI, ADX) are already warmed up
- The 9:45 AM gate was overly conservative and caused the bot to miss high-quality early-session moves
- 15-minute candles are stable enough after the first candle to start trading

**Impact:** Bot can now capture early morning momentum moves between 9:30-9:45 AM that were previously missed.

---


## v-final — SL & Trailing SL Overhaul (2026-03-22)

### Summary
Full audit and fix of Stop Loss and Trailing Stop Loss logic across all three modes
(Live Trade, Paper Trade, Backtest). All three modes now behave identically.

---

### Change 1 — `TRAIL_ACTIVATE_PTS` default aligned across all files

**File:** `src/routes/trade.js`

**Before:** `TRAIL_ACTIVATE_PTS` defaulted to `10` in live trade.
**After:** Defaulted to `15` — matching paper trade and backtest.

**Why it mattered:** Live trade was activating the trail 5 pts earlier than paper and
backtest. Paper trade results did not reflect live behaviour, making backtesting
misleading for tuning the trail.

---

### Change 2 — Dynamic `trailActivatePts` per trade (all 3 modes)

**Files:** `src/routes/trade.js`, `src/routes/paperTrade.js`, `src/services/backtestEngine.js`

**Before:** All trades used a single fixed `TRAIL_ACTIVATE_PTS` env value (default 15).

**After:** Each trade computes its own activation threshold at entry:
```
trailActivatePts = max(TRAIL_ACTIVATE_PTS, round(initialSARgap × 0.25))
```

**Examples:**
- SAR gap = 60 pts → activate at max(15, 15) = **15 pts**
- SAR gap = 80 pts → activate at max(15, 20) = **20 pts**
- SAR gap = 120 pts → activate at max(15, 30) = **30 pts**

**Why it matters:** A wider SAR gap at entry means you accepted more risk. The trail
should not activate at the same 15 pts regardless — a 120 pt SL trade locking in
at +15 pts still has 105 pts of risk remaining below. Dynamic activation scales
trail protection proportionally to the actual risk taken.

**Stored on position object:** `pos.trailActivatePts` — visible in the live status
JSON and in logs. The env `TRAIL_ACTIVATE_PTS` now acts as the floor only.

---

### Change 3 — 50% floor/ceiling on trail SL added to Live Trade

**File:** `src/routes/trade.js`

**Before:** Live trade trail moved `pos.stopLoss` to `bestPrice ± gap` with no lower
bound, meaning the trail SL could sit **below** `entryPrevMid` (CE) or **above**
`entryPrevMid` (PE) during early small moves. This was inconsistent with both paper
trade and backtest, which already had this floor applied.

**After:** Same 50% floor/ceiling logic as paper trade:
```
CE: effectiveTrailSL = trailSL < entryPrevMid ? entryPrevMid : trailSL
PE: effectiveTrailSL = trailSL > entryPrevMid ? entryPrevMid : trailSL
```
Trail is clipped at `entryPrevMid` until the price naturally moves the trail past it.
Logs show `[50%floor=₹X]` or `[50%ceil=₹X]` when clipping is active.

**Why it matters:** Without this, a CE entry where the trail had not yet cleared
`entryPrevMid` would have a looser SL in live than in paper/backtest. Paper might
exit a losing trade at `entryPrevMid` while live would let it run further into loss.

---

### Change 4 — `_slHitCandleTime` no longer set on trailing SL exits (all 3 modes)

**Files:** `src/routes/trade.js`, `src/routes/paperTrade.js`

**Before:** Any SL hit — whether the initial SAR stop or a trailing SL — would set
`_slHitCandleTime`, blocking all re-entry for the remainder of that candle.

**After:** `_slHitCandleTime` is only set when the **initial SL is hit before the
trail has activated** (i.e. a pure losing trade, no profit captured):
```js
const wasTrailing = pos.bestPrice && (moveInFavour >= TRAIL_ACTIVATE);
if (!wasTrailing) _slHitCandleTime = currentBar.time;
```

**Why it matters:** A trailing SL exit is a **profitable exit** — the trade was in
profit and the trail locked in gains. Blocking re-entry on the same candle after a
profitable exit is wrong. A fresh, valid signal that forms after the trailing exit
on the same candle was being silently skipped. This change allows those re-entries
while still blocking re-entry after a pure initial-SL loss (to avoid doubling down
on a failed direction).

**Locations fixed:**
- `trade.js` — CE trail SL hit
- `trade.js` — PE trail SL hit
- `paperTrade.js` — CE trail SL hit
- `paperTrade.js` — PE trail SL hit

---

### Change 5 — `_slHitCandleTime` removed from 50%-rule intra-tick exits

**File:** `src/routes/trade.js`

**Before:** When the 50%-rule fired intra-tick (spot crossing `entryPrevMid`), it set
`_slHitCandleTime` in addition to starting `_fiftyPctPauseUntil`. This meant two
separate re-entry blocks were active simultaneously, with `_slHitCandleTime` being
the more aggressive one (same-candle block vs. the 2-candle `_fiftyPctPauseUntil`).

**After:** `_slHitCandleTime` is **not** set on 50%-rule exits. The existing
`_fiftyPctPauseUntil` (2-candle pause) is sufficient and is the correct mechanism.

**Why it matters:** A 50%-rule exit is a protective exit to prevent a known-bad
trade from losing more. It is not the same as an initial SL hit. The 2-candle pause
already prevents chasing back into a choppy market. The `_slHitCandleTime` block was
redundant and conflated two different exit types.

---

### Change 6 — Backtest trail upgraded from flat gap to tiered dynamic

**File:** `src/services/backtestEngine.js`

**Before:** Backtest used a single flat `TRAIL_GAP_PTS = 60` for all trails, at all
profit levels, for all trades.

**After:** Same tiered `getDynamicTrailGap()` as paper/live:
```
T1: 0 – TRAIL_TIER1_UPTO pts gain  → gap = TRAIL_TIER1_GAP  (default 60pt)
T2: TIER1_UPTO – TRAIL_TIER2_UPTO  → gap = TRAIL_TIER2_GAP  (default 40pt)
T3: above TRAIL_TIER2_UPTO          → gap = TRAIL_TIER3_GAP  (default 30pt)
```
Configured via the same env vars as paper/live: `TRAIL_TIER1_UPTO`, `TRAIL_TIER2_UPTO`,
`TRAIL_TIER1_GAP`, `TRAIL_TIER2_GAP`, `TRAIL_TIER3_GAP`.

**Why it matters:** Backtest results were previously not representative of live/paper
behaviour. A trade that went +80 pts in backtest used a 60 pt gap, but in live it
would have tightened to 40 pt, exiting with more profit locked in. Now backtest
results are directly comparable to live/paper performance, making strategy tuning
through backtesting meaningful.

---

### Change 7 — `initialStopLoss` and `trailActivatePts` added to position object

**Files:** `src/routes/trade.js`, `src/routes/paperTrade.js`, `src/services/backtestEngine.js`

Both fields are now stored at entry and never mutated:
- `initialStopLoss` — the SAR stop at entry time (before any trailing). Useful for
  post-trade analysis and for determining whether a trailing SL exit was profitable.
- `trailActivatePts` — the computed dynamic threshold for this specific trade.

`initialStopLoss` is also included in saved trade history (already existed in backtest,
now consistent across all 3 modes). Both fields are exposed in the live status JSON
endpoint (`/trade/status/data`).

---

### Performance Optimisations (no behaviour change)

**`src/routes/trade.js`**
- `getDynamicTrailGap()` already cached tier constants at module load — no per-tick
  `parseFloat(process.env...)` calls. Confirmed still in place.
- `_TRAIL_ACTIVATE_PTS` cached at module load — consistent with paper trade.

**`src/services/backtestEngine.js`**
- `getDynamicTrailGap()` defined inside `runBacktest()` with closure over the tier
  constants — zero repeated env parsing across the entire backtest run.
- Trail log now prints `gap=Xpt` alongside the tier label for easier debugging without
  needing to cross-reference tier thresholds.

---

### Environment Variables Reference (`.env`)

All trail parameters configurable — defaults shown:

```env
# Trail activation floor (dynamic threshold = max of this and 25% of SAR gap)
TRAIL_ACTIVATE_PTS=15

# Tiered gap thresholds (profit points at which gap tightens)
TRAIL_TIER1_UPTO=40         # 0–40 pts profit → T1 gap
TRAIL_TIER2_UPTO=70         # 40–70 pts profit → T2 gap
                             # 70+ pts profit → T3 gap

# Gap sizes per tier
TRAIL_TIER1_GAP=60          # T1: widest (early move, needs room)
TRAIL_TIER2_GAP=40          # T2: tightening
TRAIL_TIER3_GAP=30          # T3: tightest (locking in large profit)
```

---

### Behaviour Matrix After This Release

| Feature | Live | Paper | Backtest |
|---|---|---|---|
| `TRAIL_ACTIVATE_PTS` default | 15 ✅ | 15 ✅ | 15 ✅ |
| Dynamic `trailActivatePts` (25% SAR gap) | ✅ | ✅ | ✅ |
| Tiered trail gap (T1/T2/T3) | ✅ | ✅ | ✅ |
| 50% floor/ceiling on trail | ✅ | ✅ | ✅ |
| `_slHitCandleTime` skipped on trail exit | ✅ | ✅ | N/A |
| `_slHitCandleTime` skipped on 50% exit | ✅ | ✅ | N/A |
| `initialStopLoss` stored on position | ✅ | ✅ | ✅ |
| `trailActivatePts` stored on position | ✅ | ✅ | ✅ |

---

## Previous Versions

All prior changes documented inline in strategy and engine source files.
See version comments in `src/strategies/strategy1_sar_ema_rsi.js` (v52–v60)
and `src/services/backtestEngine.js` (v20–v53).

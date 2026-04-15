# Changelog

All notable changes to the Palani Andawar Trading Bot are documented in this file.

---

## v4.0.0 — Price Action Strategy, Simulation Engine, and Full Platform Upgrade (2026-04-15)

### New Strategy: Price Action (5-min)

- **Strategy 3 — `PRICE_ACTION_5M`**: Pure price-pattern recognition on 5-min candles with RSI confluence
  - Patterns: Bullish/Bearish Engulfing, Pin Bar (Hammer/Shooting Star), Inside Bar Breakout, Break of Structure, Double Top/Bottom, Ascending/Descending Triangle
  - Dynamic S/R zones from swing highs/lows (last 30 candles, zone = swing ±10pts)
  - RSI confluence: CE requires RSI > 45, PE requires RSI < 55
  - SL = signal candle wick boundary
  - Full mode support: PA Live (`/pa-live`), PA Paper (`/pa-paper`), PA Backtest (`/pa-backtest`)
  - Fyers order placement for live mode

### Market Scenario Simulator

- After-hours paper trade testing with realistic tick generation
- 8 market scenarios: `trending_up`, `trending_down`, `choppy`, `volatile`, `breakout_up`, `breakout_down`, `v_recovery`, `inverted_v`
- Each scenario generates ~75 candles simulating a full 9:15–15:30 session
- Feeds ticks into the production `onTick()` pipeline — full strategy logic (SL, trailing, exit rules) runs identically to live
- Available for all 3 modes: `/paperTrade/simulate`, `/scalp-paper/simulate`, `/pa-paper/simulate`
- Historical date replay with 1-min candle tick replay for improved fidelity
- Resolution-aware simulated clock with correct timestamps and cooldowns

### Signal & Entry Improvements

- **ADX chop filter**: Skip entries when ADX < threshold (choppy market detection)
- **RSI overbought/oversold caps**: Block CE entries when RSI > 80, PE entries when RSI < 20
- **EMA30 filter toggle**: Optional medium-term trend gate (`EMA30_FILTER`)
- **Logic 3 CE override**: Captures lagging-SAR bullish entries that classic logic misses
- **Signal rejection breakdown**: Detailed analytics showing why signals were rejected (both trading and scalp backtest)
- **BB squeeze filter**: Skip scalp entries when Bollinger Bands are narrow (low volatility)
- **Consecutive SL escalation**: Widen SL after consecutive losses to avoid whipsaw
- **Rebalanced trailing**: Improved trail activation and gap defaults

### Scalp Strategy Enhancements

- **Tiered trailing profit**: Keep more as profit grows (₹500→55%, ₹1000→60%, ₹3000→70%, ₹5000→80%, ₹10000→90%)
- **PSAR trailing SL**: Only tightens, never widens; PSAR flip = immediate exit
- **SL source tracking**: Exit reasons now show whether SL was PSAR-based or Prev Candle-based
- **Previous candle SL** restored as default (replaced short-lived ATR-based SL experiment)
- **Default resolution changed from 3-min to 5-min** for scalp mode
- **VIX filter fully decoupled**: Separate `SCALP_VIX_ENABLED` toggle independent of trading VIX
- **Look-ahead bias eliminated** in scalp backtest — entries now on next candle open
- **SL recalculated relative to actual entry price**; gap-past entries skipped

### Capital Protection & Risk Management

- **Hard SL layer**: Additional absolute stop-loss as a safety net
- **Crash recovery**: Active positions persisted to disk (`~/trading-data/`); orphan detection + Telegram alert on restart
- **Staleness alerts**: Warns if data feed goes stale during active position
- **Health check button** on Settings page with status modal

### UI & Dashboard

- **Paper vs Backtest comparison page** (`/compare/trading`, `/compare/scalping`) — side-by-side metrics: total trades, win rate, PnL, max drawdown, equity curve
- **EC2 instance health monitor** (`/monitor`) — real-time CPU, RAM, disk, load average, uptime charts
- **Analytics panels** on both trading and scalp backtest pages — win/loss distribution, streak analysis, time-of-day performance
- **Detailed loss analytics** in scalp backtest
- **Day view summary table** with copy buttons on backtest pages
- **Day/night theme toggle** — hand-crafted light theme with proper CSS (replaced initial filter-invert approach)
- **Collapsible accordion sections** on settings page
- **Eye icon summary modals** for trading & scalping settings (with copy button)
- **Env key name display** after effect badge in settings UI
- **GitHub Actions deploy status widget** — floating chip in bottom-right, webhook-driven (`/deploy/webhook`)
- **Simulate links** added to sidebar navigation
- **Per-session delete button** and copy trade log in scalp history
- **Chart.js colors now theme-aware** across all pages
- **Auto-refresh** on scalp pages when returning from background tab

### Backtest & Analytics

- **Disk cache for candle data** (`~/trading-data/backtest_cache/`) — reduces Fyers API calls, 90-day auto-prune
- **Backtest-style analytics** added to paper trade screens (copy trade log, day view)
- **Candle pre-load extended** from 7 to 21 days to match backtest indicator depth
- **Default backtest range** set to current month (ignores `BACKTEST_FROM/TO` env vars)

### Configuration & Settings

- **Configurable entry start/end times** for both trading and scalping
- **Configurable strategy thresholds** via Settings UI — dynamic trail activation, tighter defaults
- **STT charges updated to April 2026 rates** with configurable settings
- **Fyers-specific charge rates** — STT 0.15%, exchange txn 0.0445%
- **Expiry-day-only toggle** for both trading and scalping modes
- **NIFTY weekly expiry updated** from Thursday to Tuesday

### Infrastructure & Operations

- **Comprehensive operational logging** across broker, socket, persistence, and VIX layers
- **NSE holiday API integration** with 2026 fallback list (`/api/holidays`, `/api/expiry-dates`)
- **Docs viewer** (`/docs`) — renders README, CHANGELOG, and documents folder as styled HTML
- **Login logs** with GPS + IP-API geolocation for failed attempts (`/login-logs`)
- **PM2 auto-start** on EC2 reboot via `pm2 startup`
- **SSH deploy action pinned** to v4.1.9 for stability
- **Improved shutdown Telegram messages** distinguishing live vs paper modes
- **IST conversion optimized** — replaced expensive `toLocaleString` with fast arithmetic across hot paths

### Bug Fixes

- Fix simulation vs paper trade result mismatches across all 3 routes
- Fix simulation fidelity with 1-min candle tick replay
- Fix R:R calculation in backtest — use spot points instead of ₹ for reward
- Fix `vix.toFixed` crash in scalp backtest by calling `lookupVix()`
- Fix live scalp PSAR window alignment with paper/backtest (completed candles only)
- Fix option expiry date calculation edge cases
- Fix strike selection rounding
- Fix socket teardown when second mode starts; fix backoff loop
- Fix duplicate bar bug on scalp paper UI
- Fix trailing profit lock — protects one step below peak instead of at peak (then reverted to lock at reached level)
- Fix manual entry SL when only 1 candle exists
- Fix `modalJS` isolation into separate script tag from trade data
- Fix zero-PnL trades counted as neutral, not losses
- Fix `candlesHeld` count after trail updates in backtest
- Fix scalp paper/live option polling alignment to 1s
- Fix backtest page future month block

---

## v-final-3 — Full Consistency Sync: Backtest + Live → Paper Trade Reference (2026-03-29)

### Summary
Complete audit of all three modes (Backtest, Paper Trade, Live Trade).
Found **7 logic differences** — 1 critical bug, 2 high-impact gaps, 4 missing risk controls.
Paper Trade is now the reference implementation. All modes behave identically.

---

### CRITICAL FIX — Trail 50% Floor/Ceiling Swapped in Backtest

**File:** `src/services/backtestEngine.js`

**Before (BUG):**
```js
// CE trail: Math.min → took the LOWER value = trail gets stuck at entryPrevMid
const effectiveTrailSL = position.entryPrevMid !== null ? Math.min(trailSL, position.entryPrevMid) : trailSL;

// PE trail: Math.max → took the HIGHER value = trail gets stuck at entryPrevMid
const effectiveTrailSL = position.entryPrevMid !== null ? Math.max(trailSL, position.entryPrevMid) : trailSL;
```

**After (FIXED — matches paper/live exactly):**
```js
// CE trail: floor = trail cannot sit BELOW entryPrevMid
const clipped = fiftyPctFloor !== null && trailSL < fiftyPctFloor;
const effectiveTrailSL = clipped ? fiftyPctFloor : trailSL;

// PE trail: ceiling = trail cannot sit ABOVE entryPrevMid
const clipped = fiftyPctCeiling !== null && trailSL > fiftyPctCeiling;
const effectiveTrailSL = clipped ? fiftyPctCeiling : trailSL;
```

**Impact:** Winning trades in backtest were not locking in profits correctly.
CE trail SL was capped *down* at entryPrevMid — never tightened past it.
PE trail SL was capped *up* at entryPrevMid — never tightened past it.
Backtest results were non-representative of live/paper trailing behaviour.

---

### HIGH FIX — SL Hit Detection Changed from candle.close to candle.low/high

**File:** `src/services/backtestEngine.js`

**Before:** `candle.close < position.stopLoss` (SL only hit if candle CLOSES below SL)
**After:** `candle.low <= position.stopLoss` for CE, `candle.high >= position.stopLoss` for PE

**Why it matters:** Paper/live check SL on every tick. A candle can wick through SL
and recover by close — backtest used to survive this, paper/live would exit.
Using `candle.low`/`candle.high` as intra-candle proxy now matches tick-by-tick behaviour.
Backtest was previously overstating win rate by ignoring wick SL hits.

---

### HIGH FIX — 50% Entry Gate Added to Live Trade

**File:** `src/routes/trade.js`

**Before:** Live trade had NO 50% entry gate. Paper trade had it since simulateBuy().
**After:** Both candle-close and intra-candle entry paths now check:
```js
const violates = (side === "PE" && spot > entryPrevMid) ||
                 (side === "CE" && spot < entryPrevMid);
if (violates) { /* block entry — no directional room */ }
```

**Why it matters:** Without this gate, live trade could enter trades where the 50% exit
rule would fire on the very first tick — a guaranteed loss. Paper trade already blocked
these entries. Live was taking trades that paper would never take.

---

### 50% Entry Gate Added to Backtest

**File:** `src/services/backtestEngine.js`

Same 50% entry gate logic added before entry creation.
Previously had a comment explaining why it was intentionally skipped —
but this caused backtest to take trades that paper/live would never take.

---

### Risk Controls Added to Backtest (4 features)

**File:** `src/services/backtestEngine.js`

All 4 risk controls now match paper trade:

| Control | Paper | Backtest (before) | Backtest (after) |
|---|---|---|---|
| Daily loss kill switch (MAX_DAILY_LOSS) | ✅ | ❌ Missing | ✅ Added |
| Max daily trades cap (MAX_DAILY_TRADES) | ✅ | ❌ Missing | ✅ Added |
| Consecutive loss pause (3 losses) | ✅ | ❌ Missing | ✅ Added |
| Same-candle SL re-entry block | ✅ | ❌ Missing | ✅ Added |

All use the same env vars: `MAX_DAILY_LOSS=5000`, `MAX_DAILY_TRADES=20`.
3 consecutive losses on 15-min: kills the day. On 5-min: pauses 4 candles.
SL re-entry block: only fires on initial SL hit (not trailing SL exit).

State variables reset at start of each new trading day in the backtest loop.

---

### Behaviour Matrix After This Release

| Feature | Live | Paper | Backtest |
|---|---|---|---|
| Signal logic (getSignal) | Same ✅ | Same ✅ | Same ✅ |
| Trail 50% floor/ceiling | Correct ✅ | Correct ✅ | **Fixed** ✅ |
| SL hit detection | tick-by-tick ✅ | tick-by-tick ✅ | **low/high proxy** ✅ |
| 50% entry gate | **Added** ✅ | Has it ✅ | **Added** ✅ |
| `TRAIL_ACTIVATE_PTS` default | 15 ✅ | 15 ✅ | 15 ✅ |
| Dynamic `trailActivatePts` (25% SAR gap) | ✅ | ✅ | ✅ |
| Tiered trail gap (T1/T2/T3) | ✅ | ✅ | ✅ |
| `_slHitCandleTime` skipped on trail exit | ✅ | ✅ | **Added** ✅ |
| `_slHitCandleTime` skipped on 50% exit | ✅ | ✅ | N/A |
| Daily loss kill switch | ✅ | ✅ | **Added** ✅ |
| Consecutive loss pause | ✅ | ✅ | **Added** ✅ |
| Max daily trades cap | ✅ | ✅ | **Added** ✅ |
| `initialStopLoss` stored on position | ✅ | ✅ | ✅ |
| `trailActivatePts` stored on position | ✅ | ✅ | ✅ |

---

### Files Changed

| File | Changes |
|---|---|
| `src/services/backtestEngine.js` | 6 fixes (trail bug, SL detection, 50% gate, 4 risk controls) |
| `src/routes/trade.js` | 1 fix (50% entry gate on both entry paths) |
| `src/routes/paperTrade.js` | No changes (reference implementation) |

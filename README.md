# Palani Andawar Trading Bot

NIFTY options algorithmic trading bot with 3 independent strategies (Swing, Scalp, Price Action), dual-broker architecture (Fyers + Zerodha), background backtesting, paper trading, after-hours simulation, live NIFTY candlestick charts, consolidated cross-mode analytics (paper + live), per-module dashboard P&L cards, crash-safe JSONL trade audit, near-miss filter audit, Telegram alerts, and a full web dashboard.

## Architecture

```
Fyers WebSocket (NIFTY50 spot ticks — single connection)
        |
   socketManager (singleton, multi-callback fan-out)
        |
   ┌────┼──────────────────────────────────┐
   |    |                                  |
 Swing (15-min)       Scalp (5-min)        Price Action (5-min)
   |                       |                    |
 ┌─┴─┐                 ┌──┴──┐              ┌──┴──┐
 |   |                 |     |              |     |
Live  Paper           Live  Paper          Live  Paper
Zerodha  Simulated   Fyers  Simulated     Fyers  Simulated
orders   orders      orders  orders       orders  orders
```

All three modes run **in parallel** on the same WebSocket — different candle resolutions, different brokers, independent risk controls.

## Modes

| Mode | Strategy | Timeframe | Broker | Route Prefix |
|------|----------|-----------|--------|-------------|
| **Swing Live** | SAR + EMA9 + RSI | 15-min | Zerodha | `/swing-live` |
| **Swing Paper** | SAR + EMA9 + RSI | 15-min | Simulated | `/swing-paper` |
| **Swing Backtest** | SAR + EMA9 + RSI | 15-min | Historical | `/swing-backtest` |
| **Scalp Live** | BB + RSI + PSAR (V4) | 5-min | Fyers | `/scalp-live` |
| **Scalp Paper** | BB + RSI + PSAR (V4) | 5-min | Simulated | `/scalp-paper` |
| **Scalp Backtest** | BB + RSI + PSAR (V4) | 5-min | Historical | `/scalp-backtest` |
| **PA Live** | Price Action Patterns | 5-min | Fyers | `/pa-live` |
| **PA Paper** | Price Action Patterns | 5-min | Simulated | `/pa-paper` |
| **PA Backtest** | Price Action Patterns | 5-min | Historical | `/pa-backtest` |
| **Manual Tracker** | — (trails SL only) | 15-min | Zerodha | `/tracker` |
| **Simulation** | Any (after-hours) | Configurable | Simulated ticks | `/*/simulate` |

### Parallel Compatibility

| | Swing Live | Swing Paper | Scalp Live | Scalp Paper | PA Live | PA Paper |
|---|---|---|---|---|---|---|
| **Swing Live** | — | cannot | can | can | can | can |
| **Swing Paper** | cannot | — | can | can | can | can |
| **Scalp Live** | can | can | — | cannot | can | can |
| **Scalp Paper** | can | can | cannot | — | can | can |
| **PA Live** | can | can | can | can | — | cannot |
| **PA Paper** | can | can | can | can | cannot | — |

Backtests run in the background (one at a time) and never block live/paper modes. The dashboard has **Start-All Paper** and **Start-All Live** buttons that start every enabled mode in sequence with a single click; the two are **mutually locked** (one disables the other and pulses while active) so you never accidentally double-run paper + live across modes. Start-all failures surface in a modal instead of silently reloading.

### Dashboard Layout

- **Per-module cards** (Swing / Scalp / PA) — each card has its own Paper/Live toggle, trades, win-rate, total-P&L, and a cumulative P&L chart. Charts colour green/red by P&L sign.
- **Cumulative P&L card** with a Paper/Live toggle that swaps the data source feeding the per-module charts.
- **Side-by-side broker rows** (Fyers + Zerodha on one row).
- **Hover-only date labels** on charts (x-axis decluttered).

## Strategies

### Strategy 1: Swing — SAR + EMA9 + RSI (15-min)
- **Entry**: EMA9 OHLC4 touch + SAR positioning + RSI momentum + ADX trend + EMA slope
- **Filters**: ADX chop filter (skip low-ADX), RSI overbought/oversold caps, VIX regime, EMA30 trend gate (optional), body >= 10pt, SAR gap >= 55pt
- **Exit**: Tiered trailing SL (T1/T2/T3) + 50% candle rule + opposite signal + EOD
- **Logic 3 override**: Captures lagging-SAR CE entries that classic logic misses

### Strategy 2: Scalp — BB + RSI + PSAR V4 (5-min)
- **Entry**: Close beyond Bollinger Band + RSI confirmation (> 55 for CE, < 45 for PE)
- **V4 quality filters** (opt-in via Settings): approach filter (reject first-touch breakouts), body-strength filter (reject doji/wick breakouts)
- **Trend filter** (`SCALP_TREND_FILTER`, default on): block CE in downtrends / PE in uptrends using BB-mid slope + N-candle momentum
- **Other filters**: BB squeeze filter (skip narrow bands), VIX filter (independent toggle + threshold), activity filter, CPR narrow filter
- **SL**: Previous candle low/high (capped between min/max pts)
- **Exit**: Initial SL + tiered trailing profit % of peak + PSAR trailing (only tightens) + PSAR flip + bid-ask spread guard + time-stop on flat trades
- **Trail tiers**: ₹500→55%, ₹1000→60%, ₹3000→70%, ₹5000→80%, ₹10000→90%
- **Trail grace period**: Suppress trail-exit for first N seconds after entry (SL still active) to protect against first-tick spike + tiny pullback

### Strategy 3: Price Action — Patterns + S/R Zones (5-min)
- **Patterns**: Bullish/Bearish Engulfing, Pin Bar, Inside Bar Breakout, Break of Structure, Double Top/Bottom, Ascending/Descending Triangle
- **S/R Zones**: Dynamic from swing highs/lows (last 30 candles, zone = swing ±10pts)
- **RSI confluence**: CE requires RSI > 45, PE requires RSI < 55 (optional RSI caps block overbought CE / oversold PE)
- **SL**: Signal candle wick, capped to `[PA_MIN_SL_PTS=8, PA_MAX_SL_PTS=12]`. BOS/Inside-Bar setups are skipped if the raw structural SL exceeds `PA_MAX_STRUCT_SL_PTS=15` (thin-structure / false-breakout guard).
- **Exit**: Candle trail (prev N-bar H/L, parallel with profit-lock floor) + tiered profit-lock + PSAR + PA-specific time-stop (3 candles / ±10pts) + bid-ask spread guard
- **Tightening goal**: cap loss/trade and let winners run via the existing trail stack

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
  historical_pnl.json             # One-time P&L baselines per broker (Kite / Fyers)
  .active_trade_position.json     # Crash recovery — swing position
  .active_scalp_position.json     # Crash recovery — scalp position
  .active_pa_position.json        # Crash recovery — PA position
  swing_paper_trades_log.jsonl    # Crash-safe per-trade JSONL audit (cumulative)
  scalp_paper_trades_log.jsonl
  pa_paper_trades_log.jsonl
  trades/                         # Per-day JSONL files: {mode}_paper_trades_YYYY-MM-DD.jsonl
  backtest_cache/                 # Cached historical candles (90-day auto-prune)
  candle_cache/                   # Live candle cache (60-day trim)
  reports/                        # Daily trade reports
```

## Key .env Settings

### Swing Strategy (15-min, Zerodha)
| Key | Default | Notes |
|-----|---------|-------|
| `TRADE_RESOLUTION` | `15` | Candle size in minutes |
| `MAX_DAILY_LOSS` | `5000` | Daily kill-switch in INR |
| `MAX_DAILY_TRADES` | `20` | Daily entry cap |
| `SWING_LIVE_ENABLED` | `false` | Must be `true` for Zerodha orders |
| `BACKTEST_OPTION_SIM` | `true` | Realistic option P&L (delta x theta) |
| `EMA30_FILTER` | `true` | Medium-term trend gate |
| `TRADE_ENTRY_START` | `09:30` | Earliest entry time (IST) |
| `TRADE_ENTRY_END` | `14:00` | Latest entry time (IST) |
| `TRADE_EXPIRY_DAY_ONLY` | `false` | Only trade on NIFTY expiry day |

### Scalp Mode (5-min, Fyers)
| Key | Default | Notes |
|-----|---------|-------|
| `SCALP_MODE_ENABLED` | `true` | Show/hide scalp menus in sidebar |
| `SCALP_ENABLED` | `false` | Must be `true` for Fyers scalp orders |
| `SCALP_RESOLUTION` | `5` | Scalp candle size |
| `SCALP_MAX_SL_PTS` | `25` | Max SL distance (pts) |
| `SCALP_MIN_SL_PTS` | `8` | Min SL distance (pts) |
| `SCALP_TRAIL_START` | `350` | Activate trailing after ₹N profit |
| `SCALP_TRAIL_TIERS` | `500:55,1000:60,3000:70,5000:80,10000:90` | Peak:pct ladder |
| `SCALP_TRAIL_GRACE_SECS` | `0` | Suppress trail-exit for first N secs after entry (SL still active) |
| `SCALP_REQUIRE_APPROACH` | `false` | V4: block entry if prev candle is on opposite BB half |
| `SCALP_MIN_BODY_RATIO` | `0` | V4: min entry-candle body as % of range (0.5 skips doji/wick breakouts) |
| `SCALP_TREND_FILTER` | `true` | Block CE in downtrends / PE in uptrends (BB-mid slope + momentum) |
| `SCALP_TREND_MOMENTUM_PCT` | `0.15` | Min N-candle move (% of price) to call a direction |
| `SCALP_TREND_MOMENTUM_LOOKBACK` | `5` | Candles for momentum measurement |
| `SCALP_TREND_MID_SLOPE_LOOKBACK` | `3` | Candles for BB-mid slope measurement |
| `SCALP_MAX_DAILY_TRADES` | `30` | Daily scalp cap |
| `SCALP_MAX_DAILY_LOSS` | `2000` | Scalp kill-switch in INR |
| `SCALP_VIX_ENABLED` | `false` | Independent VIX filter for scalp |
| `SCALP_VIX_MAX_ENTRY` | (falls back to `VIX_MAX_ENTRY`) | Per-mode VIX block-entry threshold |
| `SCALP_VIX_STRONG_ONLY` | (falls back to `VIX_STRONG_ONLY`) | Per-mode strong-only threshold |
| `SCALP_BB_SQUEEZE_FILTER` | `true` | Skip entries when BB bands narrow |

### Price Action Mode (5-min, Fyers)
| Key | Default | Notes |
|-----|---------|-------|
| `PA_MODE_ENABLED` | `true` | Show/hide PA menus in sidebar |
| `PA_ENABLED` | `false` | Must be `true` for Fyers PA live orders |
| `PA_RESOLUTION` | `5` | Candle size in minutes |
| `PA_MAX_SL_PTS` | `12` (signal) / `25` (route fallback) | Strategy caps signal SL at 12; routes fall back to 25 if signal-level cap is bypassed |
| `PA_MIN_SL_PTS` | `8` | Floor for SL distance |
| `PA_MAX_STRUCT_SL_PTS` | `15` | Skip BOS/Inside-Bar setups when raw structural SL exceeds this |
| `PA_CANDLE_TRAIL_ENABLED` | `true` | Use prev N-bar H/L as trail exit |
| `PA_CANDLE_TRAIL_BARS` | `2` | Lookback for candle trail |
| `PA_TRAIL_START` | `350` | Activate trailing after ₹N profit |
| `PA_TRAIL_TIERS` | `500:55,1000:60,3000:70,5000:80,10000:90` | Peak:pct ladder |
| `PA_TIME_STOP_CANDLES` | `3` | Auto-exit flat trades after N candles (PA override of global `4`) |
| `PA_TIME_STOP_FLAT_PTS` | `10` | "Flat" threshold for time-stop (PA override of global `20`) |
| `PA_RSI_CAPS_ENABLED` | `false` | Block CE when RSI overbought / PE when oversold |
| `PA_PATTERN_ENGULFING` | `true` | Toggle Bullish/Bearish Engulfing at S/R |
| `PA_PATTERN_PINBAR` | `true` | Toggle Hammer / Shooting Star (pin bars) at S/R |
| `PA_PATTERN_BOS` | `true` | Toggle Break-of-Structure (close beyond swing) |
| `PA_PATTERN_INSIDE_BAR` | `true` | Toggle Inside Bar mother-bar breakout |
| `PA_PATTERN_DOUBLE_TOP` | `false` | Toggle Double Top (M) bearish reversal |
| `PA_PATTERN_DOUBLE_BOTTOM` | `false` | Toggle Double Bottom (W) bullish reversal |
| `PA_PATTERN_ASC_TRIANGLE` | `false` | Toggle Ascending Triangle bullish breakout |
| `PA_PATTERN_DESC_TRIANGLE` | `false` | Toggle Descending Triangle bearish breakdown |
| `PA_MAX_DAILY_TRADES` | `30` | Daily PA cap |
| `PA_MAX_DAILY_LOSS` | `2000` | PA kill-switch in INR |
| `PA_VIX_ENABLED` | `false` | Independent VIX filter for PA |
| `PA_VIX_MAX_ENTRY` | (falls back to `VIX_MAX_ENTRY`) | Per-mode VIX block-entry threshold |
| `PA_VIX_STRONG_ONLY` | (falls back to `VIX_STRONG_ONLY`) | Per-mode strong-only threshold |

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
| `PA_VIX_STRONG_ONLY` | inherits | Per-mode threshold |

### Trade Guards (shared across modes)
| Key | Default | Notes |
|-----|---------|-------|
| `MAX_BID_ASK_SPREAD_PTS` | `2` | Block entry when option bid-ask spread > N pts (fails open if quotes missing) |
| `TIME_STOP_CANDLES` | `4` | Auto-exit a trade flat for N candles |
| `TIME_STOP_FLAT_PTS` | `20` | "Flat" defined as |PnL| < N points |

### UI Visibility Toggles
| Key | Default | Notes |
|-----|---------|-------|
| `UI_SHOW_SIMULATE` | `false` | Show "Simulate" link under each mode in sidebar |
| `UI_SHOW_COMPARE` | `false` | Show "Compare" link |
| `UI_SHOW_TRACKER` | `false` | Show "Tracker" under Swing |

### Telegram Alerts (17 toggles + master gate)
| Key | Default | Notes |
|-----|---------|-------|
| `TELEGRAM_BOT_TOKEN` | — | From @BotFather |
| `TELEGRAM_CHAT_ID` | — | Your chat ID |
| `TG_ENABLED` | `true` | **Master gate** — when off, no alerts send regardless of below |
| `TG_{SWING,SCALP,PA}_STARTED` | `true` | Session-start alerts per mode |
| `TG_{SWING,SCALP,PA}_ENTRY` | `true` | Trade-entry alerts per mode |
| `TG_{SWING,SCALP,PA}_EXIT` | `true` | Trade-exit alerts per mode |
| `TG_{SWING,SCALP,PA}_SIGNALS` | `true/false/false` | Candle-close skip/signal reasoning per mode |
| `TG_{SWING,SCALP,PA}_DAYREPORT` | `true` | Per-mode day-report on session stop |
| `TG_DAYREPORT_CONSOLIDATED` | `true` | One combined day report at 15:30 IST across all modes |

### Charges (April 2026 rates)
| Key | Default | Notes |
|-----|---------|-------|
| `STT_OPT_SELL_PCT` | `0.15` | STT on options sell-side (%) |
| `STT_FUT_SELL_PCT` | `0.05` | STT on futures sell-side (%) |
| `EXCHANGE_TXN_OPT_PCT` | `0.05` | NSE exchange txn for options (%) |
| `GST_PCT` | `18` | GST on brokerage + exchange charges |
| `BROKER_FLAT_PER_ORDER` | `20` | Flat brokerage per order (×2 for buy+sell) |

## Routes

### Swing
| URL | Description |
|-----|-------------|
| `/` | Dashboard (with Start-All Paper / Start-All Live buttons) |
| `/swing-backtest` | Run backtest (15-min SAR+EMA9+RSI) |
| `/swing-paper/status` | Paper trade live view + NIFTY chart |
| `/swing-paper/history` | Past paper sessions (per-session delete + view modal) |
| `/swing-paper/simulate` | Market scenario simulator |
| `/swing-live/status` | Live trade status + NIFTY chart |
| `/tracker/status` | Manual trade tracker |

### Scalp
| URL | Description |
|-----|-------------|
| `/scalp-backtest` | Scalp backtest (5-min BB+RSI+PSAR V4) |
| `/scalp-paper/status` | Scalp paper trade + NIFTY chart with BB overlay |
| `/scalp-paper/history` | Past scalp sessions (per-session delete + view modal) |
| `/scalp-paper/simulate` | Scalp simulator |
| `/scalp-live/status` | Scalp live trade + NIFTY chart |

### Price Action
| URL | Description |
|-----|-------------|
| `/pa-backtest` | PA backtest (5-min patterns) |
| `/pa-paper/status` | PA paper trade + NIFTY chart with swing overlay |
| `/pa-paper/history` | PA sessions (per-session delete + view modal) |
| `/pa-paper/simulate` | PA simulator |
| `/pa-live/status` | PA live trade + NIFTY chart |

### Analytics & Tools
| URL | Description |
|-----|-------------|
| `/consolidation` | Cross-mode **paper** trade history + analytics (Swing + Scalp + PA, daily/monthly/yearly roll-ups, Day View panel, per-mode breakdown) |
| `/live-consolidation` | Cross-mode **live** trade history + analytics (parity with `/consolidation` for live data) |
| `/pnl-history` | Broker-wise realised P&L (one-time past baselines per broker + auto-computed live-bot P&L by FY) |
| `/compare/trading` | Paper vs Backtest comparison (swing) |
| `/compare/scalping` | Paper vs Backtest comparison (scalping) |
| `/settings` | All config settings UI + Bulk Edit modal (paste/delete keys) + server restart |
| `/monitor` | EC2 health metrics (CPU, RAM, disk, load average) + maintenance actions |
| `/logs` | Application logs (with SSE live feed; near-miss audit lines visible here) |
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

### API Endpoints
| URL | Description |
|-----|-------------|
| `/api/holidays` | NSE holiday list |
| `/api/holidays/refresh` | Refresh NSE holiday cache |
| `/api/expiry-dates` | NIFTY weekly/monthly expiry calendar |
| `/api/cache-info` | Candle cache stats |
| `/auth/status/all` | Combined broker auth status |

## Project Structure

```
src/
  app.js                              # Express server, dashboard, route registration, Start-All
  strategies/
    strategy1_sar_ema_rsi.js          # Swing 15-min strategy (SAR + EMA9 + RSI)
    scalp_bb_cpr.js                   # Scalp 5-min V4 (BB + RSI + PSAR + approach/body filters)
    price_action.js                   # Price action 5-min strategy (patterns + S/R + RSI caps)
    index.js                          # Strategy registry
  services/
    backtestEngine.js                 # Historical candle fetch + backtest engine
    tickSimulator.js                  # Market scenario tick generator + historical replay (zigzag ticks)
    vixFilter.js                      # VIX market regime filter
    zerodhaBroker.js                  # Zerodha Kite order placement (swing live)
    fyersBroker.js                    # Fyers order placement (scalp live + PA live)
    logger.js                         # Console interceptor + in-memory log store
  routes/
    swingLive.js                      # Swing live (15-min, Zerodha) + chart + /reset endpoint
    swingPaper.js                     # Swing paper (15-min, simulated) + chart + view modal + history JSONL download
    swingBacktest.js                  # Swing backtest (15-min, split-by-years/months)
    scalpLive.js                      # Scalp live (5-min, Fyers) + chart + BB overlay + /reset endpoint
    scalpPaper.js                     # Scalp paper (5-min, simulated) + chart + BB overlay
    scalpBacktest.js                  # Scalp backtest
    paLive.js                         # PA live (5-min, Fyers) + chart + swing overlay + /reset endpoint
    paPaper.js                        # PA paper (5-min, simulated) + chart + swing overlay
    paBacktest.js                     # PA backtest
    manualTracker.js                  # Manual position tracker + SL trailer
    consolidation.js                  # Cross-mode PAPER trade history + Day View + analytics
    liveConsolidation.js              # Cross-mode LIVE trade history + analytics (parity with /consolidation)
    pnlHistory.js                     # Broker baselines + live-bot P&L by FY
    compare.js                        # Paper vs Backtest comparison pages
    settings.js                       # Settings UI + Bulk Edit modal (paste/delete keys) + restart endpoint
    monitor.js                        # EC2 health metrics + maintenance actions
    logs.js                           # Log viewer + SSE stream (near-miss audit visible)
    docs.js                           # README/CHANGELOG/docs viewer
    auth.js                           # Fyers + Zerodha OAuth
    deploy.js                         # GitHub Actions webhook + status
    loginLogs.js                      # Failed login attempt viewer
    result.js                         # Saved backtest result viewer
  utils/
    socketManager.js                  # Fyers WebSocket singleton + fan-out
    sharedSocketState.js              # Mode coexistence manager
    sharedNav.js                      # Sidebar (accordion) + per-feature menu toggles
    positionPersist.js                # Crash recovery — position save/load
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

- **Login gate**: Cookie-based password (`LOGIN_SECRET`), 15-min sliding expiry, rate limiting (5 attempts/15 min/IP), `SameSite=Lax` cookie for mobile OAuth compatibility
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

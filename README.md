# Palani Andawar Trading Bot

NIFTY options algorithmic trading bot with 3 independent strategies (Swing, Scalp, Price Action), dual-broker architecture (Fyers + Zerodha), background backtesting, paper trading, after-hours simulation, live NIFTY candlestick charts, consolidated cross-mode analytics, Telegram alerts, and a full web dashboard.

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

Backtests run in the background (one at a time) and never block live/paper modes. The dashboard has **Start-All Paper** and **Start-All Live** buttons that start every enabled mode in sequence with a single click.

## Strategies

### Strategy 1: Swing — SAR + EMA9 + RSI (15-min)
- **Entry**: EMA9 OHLC4 touch + SAR positioning + RSI momentum + ADX trend + EMA slope
- **Filters**: ADX chop filter (skip low-ADX), RSI overbought/oversold caps, VIX regime, EMA30 trend gate (optional), body >= 10pt, SAR gap >= 55pt
- **Exit**: Tiered trailing SL (T1/T2/T3) + 50% candle rule + opposite signal + EOD
- **Logic 3 override**: Captures lagging-SAR CE entries that classic logic misses

### Strategy 2: Scalp — BB + RSI + PSAR V4 (5-min)
- **Entry**: Close beyond Bollinger Band + RSI confirmation (> 55 for CE, < 45 for PE)
- **V4 quality filters** (opt-in via Settings): approach filter (reject first-touch breakouts), body-strength filter (reject doji/wick breakouts)
- **Other filters**: BB squeeze filter (skip narrow bands), VIX filter (independent toggle), activity filter, CPR narrow filter
- **SL**: Previous candle low/high (capped between min/max pts)
- **Exit**: Initial SL + tiered trailing profit % of peak + PSAR trailing (only tightens) + PSAR flip
- **Trail tiers**: ₹500→55%, ₹1000→60%, ₹3000→70%, ₹5000→80%, ₹10000→90%
- **Trail grace period**: Suppress trail-exit for first N seconds after entry (SL still active) to protect against first-tick spike + tiny pullback

### Strategy 3: Price Action — Patterns + S/R Zones (5-min)
- **Patterns**: Bullish/Bearish Engulfing, Pin Bar, Inside Bar Breakout, Break of Structure, Double Top/Bottom, Ascending/Descending Triangle
- **S/R Zones**: Dynamic from swing highs/lows (last 30 candles, zone = swing ±10pts)
- **RSI confluence**: CE requires RSI > 45, PE requires RSI < 55 (optional RSI caps block overbought CE / oversold PE)
- **SL**: Signal candle wick boundary
- **Exit**: Candle trail (prev N-bar H/L, parallel with profit-lock floor) + tiered profit-lock + PSAR

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
  backtest_cache/                 # Cached historical candles (90-day auto-prune)
  candle_cache/                   # Live candle cache (60-day trim)
  reports/                        # Daily trade reports
```

## Key .env Settings

### Swing Strategy (15-min, Zerodha)
| Key | Default | Notes |
|-----|---------|-------|
| `TRADE_RESOLUTION` | `15` | Candle size in minutes |
| `MAX_DAILY_LOSS` | `3000` | Daily kill-switch in INR |
| `MAX_DAILY_TRADES` | `10` | Daily entry cap |
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
| `SCALP_MAX_DAILY_TRADES` | `30` | Daily scalp cap |
| `SCALP_MAX_DAILY_LOSS` | `2000` | Scalp kill-switch in INR |
| `SCALP_VIX_ENABLED` | `false` | Independent VIX filter for scalp |
| `SCALP_BB_SQUEEZE_FILTER` | `true` | Skip entries when BB bands narrow |

### Price Action Mode (5-min, Fyers)
| Key | Default | Notes |
|-----|---------|-------|
| `PA_MODE_ENABLED` | `true` | Show/hide PA menus in sidebar |
| `PA_ENABLED` | `false` | Must be `true` for Fyers PA live orders |
| `PA_RESOLUTION` | `5` | Candle size in minutes |
| `PA_MAX_SL_PTS` | `25` | Max SL distance (pts) |
| `PA_CANDLE_TRAIL_ENABLED` | `true` | Use prev N-bar H/L as trail exit |
| `PA_CANDLE_TRAIL_BARS` | `2` | Lookback for candle trail |
| `PA_TRAIL_START` | `350` | Activate trailing after ₹N profit |
| `PA_TRAIL_TIERS` | `500:55,1000:60,3000:70,5000:80,10000:90` | Peak:pct ladder |
| `PA_RSI_CAPS_ENABLED` | `false` | Block CE when RSI overbought / PE when oversold |
| `PA_CHART_PATTERNS_ENABLED` | `false` | Enable Double Top/Bottom + Triangles |
| `PA_MAX_DAILY_TRADES` | `30` | Daily PA cap |
| `PA_MAX_DAILY_LOSS` | `2000` | PA kill-switch in INR |

### VIX Filter
| Key | Default | Notes |
|-----|---------|-------|
| `VIX_FILTER_ENABLED` | `true` | Block Swing entries in high-VIX |
| `VIX_MAX_ENTRY` | `20` | Block all entries above this |
| `VIX_STRONG_ONLY` | `16` | Only STRONG signals above this |
| `VIX_FAIL_MODE` | `closed` | When VIX unavailable: closed = block (safe), open = allow |
| `SCALP_VIX_ENABLED` | `false` | Independent VIX toggle for scalp |
| `PA_VIX_ENABLED` | `false` | Independent VIX toggle for PA |

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
| `/consolidation` | Cross-mode trade history + analytics (Swing + Scalp + PA combined, daily/monthly/yearly roll-ups) |
| `/pnl-history` | Broker-wise realised P&L (one-time past baselines per broker + auto-computed live-bot P&L by FY) |
| `/compare/trading` | Paper vs Backtest comparison (swing) |
| `/compare/scalping` | Paper vs Backtest comparison (scalping) |
| `/settings` | All config settings UI + bulk paste config + server restart |
| `/monitor` | EC2 health metrics (CPU, RAM, disk, load average) |
| `/logs` | Application logs (with SSE live feed) |
| `/docs` | README, CHANGELOG, documents viewer |
| `/login-logs` | Failed login attempts with geolocation |
| `/deploy/status` | GitHub Actions deploy status |
| `/health` | Health check endpoint |

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
    scalp_ema9_rsi.js                 # Scalp V1 (EMA9 cross, legacy)
    scalp_ema9_rsi_v2.js              # Scalp V2 (two-candle confirmation, legacy)
    index.js                          # Strategy registry
  services/
    backtestEngine.js                 # Historical candle fetch + backtest engine
    tickSimulator.js                  # Market scenario tick generator + historical replay (zigzag ticks)
    vixFilter.js                      # VIX market regime filter
    zerodhaBroker.js                  # Zerodha Kite order placement (swing live)
    fyersBroker.js                    # Fyers order placement (scalp live + PA live)
    logger.js                         # Console interceptor + in-memory log store
  routes/
    swingLive.js                      # Swing live trade (15-min, Zerodha) + chart
    swingPaper.js                     # Swing paper trade (15-min, simulated) + chart + view modal
    swingBacktest.js                  # Swing backtest (15-min, split-by-years/months)
    scalpLive.js                      # Scalp live (5-min, Fyers) + chart + BB overlay
    scalpPaper.js                     # Scalp paper (5-min, simulated) + chart + BB overlay
    scalpBacktest.js                  # Scalp backtest
    paLive.js                         # PA live (5-min, Fyers) + chart + swing overlay
    paPaper.js                        # PA paper (5-min, simulated) + chart + swing overlay
    paBacktest.js                     # PA backtest
    manualTracker.js                  # Manual position tracker + SL trailer
    consolidation.js                  # Cross-mode trade history + analytics (all 3 modes combined)
    pnlHistory.js                     # Broker baselines + live-bot P&L by FY
    compare.js                        # Paper vs Backtest comparison pages
    settings.js                       # Settings UI + bulk paste config + restart endpoint
    monitor.js                        # EC2 health metrics
    logs.js                           # Log viewer + SSE stream
    docs.js                           # README/CHANGELOG/docs viewer
    auth.js                           # Fyers + Zerodha OAuth
    deploy.js                         # GitHub Actions webhook + status
    loginLogs.js                      # Failed login attempt viewer
    result.js                         # Saved backtest result viewer
  utils/
    socketManager.js                  # Fyers WebSocket singleton + fan-out
    sharedSocketState.js              # Mode coexistence manager
    sharedNav.js                      # Sidebar navigation component
    positionPersist.js                # Crash recovery — position save/load
    backtestJobManager.js             # Background backtest job queue (1-at-a-time)
    backtestCache.js                  # Disk cache for historical candles
    candleCache.js                    # Live candle cache
    tradeUtils.js                     # Shared pure helpers for all trade routes
    charges.js                        # Brokerage + tax calculator
    nseHolidays.js                    # NSE holiday + expiry API
    notify.js                         # Telegram notifications (17 per-mode toggles + master gate)
    consolidatedEodReporter.js        # Single combined day report at 15:30 IST
    resultStore.js                    # Backtest result persistence
    loginLogStore.js                  # Login attempt persistence
    time.js                           # IST time helpers
  config/
    fyers.js                          # Fyers SDK singleton + token management
    instrument.js                     # Strike selection + expiry calculation
```

## Security

- **Login gate**: Cookie-based password (`LOGIN_SECRET`), 15-min sliding expiry, rate limiting (5 attempts/15 min/IP), `SameSite=Lax` cookie for mobile OAuth compatibility
- **API secret**: Token required on all action routes (start/stop/exit/save) and settings page
- **Brute-force logging**: GPS + IP-API geolocation on failed login attempts
- **Crash recovery**: Position state persisted to disk with orphan detection + Telegram alert
- **Sensitive settings hidden**: `SECRET_KEY`, `ZERODHA_API_SECRET`, `ACCESS_TOKEN`, `ZERODHA_ACCESS_TOKEN`, `TELEGRAM_BOT_TOKEN` are never shown or editable via UI

## Tech Stack

- **Runtime**: Node.js + Express (HTTPS, self-signed cert)
- **Data Feed**: Fyers WebSocket (single connection, multi-mode fan-out)
- **Indicators**: `technicalindicators` (EMA, RSI, ADX, Parabolic SAR, Bollinger Bands)
- **Brokers**: Zerodha Kite Connect (swing live) + Fyers API v3 (scalp + PA live + all data)
- **Notifications**: Telegram Bot API with 17 per-mode toggles + master gate + consolidated EOD
- **Charts**: Chart.js (theme-aware) + live candlestick overlays on status pages
- **Deployment**: PM2 on AWS EC2 t3.micro + GitHub Actions CI/CD
- **Caching**: Disk-based candle cache (backtest + live, auto-pruned)

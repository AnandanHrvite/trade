# Palani Andawar Trading Bot

NIFTY options algorithmic trading bot with 3 independent strategies, dual-broker architecture (Fyers + Zerodha), backtesting, paper trading, simulation, and a full web dashboard.

## Architecture

```
Fyers WebSocket (NIFTY50 spot ticks — single connection)
        |
   socketManager (singleton, multi-callback fan-out)
        |
   ┌────┼──────────────────────────────────┐
   |    |                                  |
 Main Mode (15-min)   Scalp Mode (5-min)   Price Action (5-min)
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
| **Live Trade** | SAR + EMA9 + RSI | 15-min | Zerodha | `/trade` |
| **Paper Trade** | SAR + EMA9 + RSI | 15-min | Simulated | `/paperTrade` |
| **Backtest** | SAR + EMA9 + RSI | 15-min | Historical | `/backtest` |
| **Scalp Live** | BB + RSI + PSAR | 5-min | Fyers | `/scalp` |
| **Scalp Paper** | BB + RSI + PSAR | 5-min | Simulated | `/scalp-paper` |
| **Scalp Backtest** | BB + RSI + PSAR | 5-min | Historical | `/scalp-backtest` |
| **PA Live** | Price Action Patterns | 5-min | Fyers | `/pa-live` |
| **PA Paper** | Price Action Patterns | 5-min | Simulated | `/pa-paper` |
| **PA Backtest** | Price Action Patterns | 5-min | Historical | `/pa-backtest` |
| **Manual Tracker** | — (trails SL only) | 15-min | Zerodha | `/tracker` |
| **Simulation** | Any (after-hours) | Configurable | Simulated ticks | `/*/simulate` |

### Parallel Compatibility

| | Live Trade | Paper Trade | Scalp Live | Scalp Paper | PA Live | PA Paper |
|---|---|---|---|---|---|---|
| **Live Trade** | — | cannot | can | can | can | can |
| **Paper Trade** | cannot | — | can | can | can | can |
| **Scalp Live** | can | can | — | cannot | can | can |
| **Scalp Paper** | can | can | cannot | — | can | can |
| **PA Live** | can | can | can | can | — | cannot |
| **PA Paper** | can | can | can | can | cannot | — |

Backtests always run independently.

## Strategies

### Strategy 1: SAR + EMA9 + RSI (15-min)
- **Entry**: EMA9 OHLC4 touch + SAR positioning + RSI momentum + ADX trend + EMA slope
- **Filters**: ADX chop filter (skip low-ADX), RSI overbought/oversold caps, VIX regime, EMA30 trend gate (optional), body >= 10pt, SAR gap >= 55pt
- **Exit**: Tiered trailing SL (T1/T2/T3) + 50% candle rule + opposite signal + EOD
- **Logic 3 override**: Captures lagging-SAR CE entries that classic logic misses

### Strategy 2: Scalp BB + RSI + PSAR (5-min)
- **Entry**: Close beyond Bollinger Band + RSI confirmation (> 55 for CE, < 45 for PE)
- **Filters**: BB squeeze filter (skip narrow bands), VIX filter (independent toggle), activity filter
- **SL**: Previous candle low/high (capped between min/max pts)
- **Exit**: Initial SL + tiered trailing profit % of peak + PSAR trailing (only tightens) + PSAR flip
- **Trail tiers**: ₹500→55%, ₹1000→60%, ₹3000→70%, ₹5000→80%, ₹10000→90%

### Strategy 3: Price Action Patterns (5-min)
- **Patterns**: Bullish/Bearish Engulfing, Pin Bar, Inside Bar Breakout, Break of Structure, Double Top/Bottom, Ascending/Descending Triangle
- **S/R Zones**: Dynamic from swing highs/lows (last 30 candles, zone = swing ±10pts)
- **RSI confluence**: CE requires RSI > 45, PE requires RSI < 55
- **SL**: Signal candle wick boundary

### Market Scenario Simulator
- After-hours testing with 8 scenarios: trending up/down, choppy, volatile, breakout up/down, V-recovery, inverted-V
- Each generates ~75 candles simulating a full 9:15–15:30 session
- Runs the production `onTick()` pipeline — same SL, trailing, exit logic as live
- Historical date replay with 1-min candle tick replay
- Available for all 3 strategy modes

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
  paper_trades.json               # Paper trade sessions
  live_trades.json                # Live trade sessions
  scalp_paper_trades.json         # Scalp paper sessions
  scalp_live_trades.json          # Scalp live sessions
  pa_paper_trades.json            # Price action paper sessions
  pa_live_trades.json             # Price action live sessions
  .active_trade_position.json     # Crash recovery — primary position
  .active_scalp_position.json     # Crash recovery — scalp position
  .active_pa_position.json        # Crash recovery — PA position
  backtest_cache/                 # Cached historical candles (90-day auto-prune)
  candle_cache/                   # Live candle cache (60-day trim)
  reports/                        # Daily trade reports
```

## Key .env Settings

### Main Strategy (15-min, Zerodha)
| Key | Default | Notes |
|-----|---------|-------|
| `TRADE_RESOLUTION` | `15` | Candle size in minutes |
| `MAX_DAILY_LOSS` | `3000` | Daily kill-switch in INR |
| `MAX_DAILY_TRADES` | `10` | Daily entry cap |
| `LIVE_TRADE_ENABLED` | `false` | Must be `true` for Zerodha orders |
| `BACKTEST_OPTION_SIM` | `true` | Realistic option P&L (delta x theta) |
| `EMA30_FILTER` | `false` | Medium-term trend gate |
| `ENTRY_START_TIME` | `09:30` | Earliest entry time (IST) |
| `ENTRY_END_TIME` | `15:00` | Latest entry time (IST) |
| `EXPIRY_DAY_ONLY` | `false` | Only trade on NIFTY expiry day |

### Scalp Mode (5-min, Fyers)
| Key | Default | Notes |
|-----|---------|-------|
| `SCALP_ENABLED` | `false` | Must be `true` for Fyers scalp orders |
| `SCALP_RESOLUTION` | `5` | Scalp candle size (1/2/3/5 min) |
| `SCALP_SL_PTS` | `12` | Stop loss distance (pts) |
| `SCALP_TARGET_PTS` | `18` | Target distance (pts) |
| `SCALP_TRAIL_GAP` | `8` | Trail gap behind best price |
| `SCALP_TRAIL_AFTER` | `10` | Activate trail after N pts profit |
| `SCALP_MAX_DAILY_TRADES` | `30` | Daily scalp cap |
| `SCALP_MAX_DAILY_LOSS` | `2000` | Scalp kill-switch in INR |
| `SCALP_VIX_ENABLED` | `true` | Independent VIX filter for scalp |

### Price Action Mode (5-min, Fyers)
| Key | Default | Notes |
|-----|---------|-------|
| `PA_ENABLED` | `false` | Must be `true` for PA live orders |
| `PA_RESOLUTION` | `5` | Candle size in minutes |
| `PA_SL_PTS` | `15` | Stop loss distance (pts) |
| `PA_MAX_DAILY_TRADES` | `20` | Daily PA cap |
| `PA_MAX_DAILY_LOSS` | `3000` | PA kill-switch in INR |

### VIX Filter
| Key | Default | Notes |
|-----|---------|-------|
| `VIX_FILTER_ENABLED` | `true` | Block entries in high-VIX (main strategy) |
| `VIX_MAX_ENTRY` | `20` | Block all entries above this |
| `VIX_STRONG_ONLY` | `16` | Only STRONG signals above this |
| `SCALP_VIX_ENABLED` | `true` | Independent VIX toggle for scalp |

### Charges (April 2026 rates)
| Key | Default | Notes |
|-----|---------|-------|
| `STT_RATE` | `0.0015` | STT on sell-side (0.15%) |
| `EXCHANGE_TXN_RATE` | `0.0005` | Exchange transaction charge |
| `FYERS_EXCHANGE_TXN_RATE` | `0.000445` | Fyers-specific exchange rate |

## Routes

### Trading
| URL | Description |
|-----|-------------|
| `/` | Dashboard |
| `/backtest` | Run backtest (15-min SAR+EMA9+RSI) |
| `/paperTrade/status` | Paper trade live view |
| `/paperTrade/history` | Past paper sessions |
| `/paperTrade/simulate` | Market scenario simulator |
| `/trade/status` | Live trade status |
| `/tracker/status` | Manual trade tracker |

### Scalping
| URL | Description |
|-----|-------------|
| `/scalp-backtest` | Scalp backtest (5-min BB+RSI+PSAR) |
| `/scalp-paper/status` | Scalp paper trade |
| `/scalp-paper/simulate` | Scalp simulator |
| `/scalp/status` | Scalp live trade |

### Price Action
| URL | Description |
|-----|-------------|
| `/pa-backtest` | PA backtest (5-min patterns) |
| `/pa-paper/status` | PA paper trade |
| `/pa-paper/simulate` | PA simulator |
| `/pa-live/status` | PA live trade |

### Analytics & Tools
| URL | Description |
|-----|-------------|
| `/compare/trading` | Paper vs Backtest comparison (trading) |
| `/compare/scalping` | Paper vs Backtest comparison (scalping) |
| `/settings` | All config settings UI |
| `/monitor` | EC2 health metrics (CPU, RAM, disk) |
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
  app.js                              # Express server, dashboard, route registration
  strategies/
    strategy1_sar_ema_rsi.js          # Main 15-min strategy (SAR + EMA9 + RSI)
    scalp_bb_cpr.js                   # Scalp 5-min strategy (BB + RSI + PSAR)
    price_action.js                   # Price action 5-min strategy (patterns + S/R)
    scalp_ema9_rsi.js                 # Scalp V1 (EMA9 cross, legacy)
    scalp_ema9_rsi_v2.js              # Scalp V2 (two-candle confirmation, legacy)
    index.js                          # Strategy registry
  services/
    backtestEngine.js                 # Historical candle fetch + backtest engine
    tickSimulator.js                  # Market scenario tick generator (8 scenarios)
    vixFilter.js                      # VIX market regime filter
    zerodhaBroker.js                  # Zerodha Kite order placement
    fyersBroker.js                    # Fyers order placement (scalp + PA)
    logger.js                         # Console interceptor + in-memory log store
  routes/
    trade.js                          # Live trade (15-min, Zerodha)
    paperTrade.js                     # Paper trade (15-min, simulated)
    scalp.js                          # Scalp live (5-min, Fyers)
    scalpPaper.js                     # Scalp paper (5-min, simulated)
    scalpBacktest.js                  # Scalp backtest
    priceActionLive.js                # PA live (5-min, Fyers)
    priceActionPaper.js               # PA paper (5-min, simulated)
    priceActionBacktest.js            # PA backtest
    backtest.js                       # Main backtest (15-min)
    manualTracker.js                  # Manual position tracker + SL trailer
    compare.js                        # Paper vs Backtest comparison pages
    settings.js                       # Settings UI + save endpoint
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
    backtestCache.js                  # Disk cache for historical candles
    candleCache.js                    # Live candle cache
    charges.js                        # Brokerage + tax calculator
    nseHolidays.js                    # NSE holiday + expiry API
    notify.js                         # Telegram notifications
    resultStore.js                    # Backtest result persistence
    loginLogStore.js                  # Login attempt persistence
    time.js                           # IST time helpers
  config/
    fyers.js                          # Fyers SDK singleton + token management
    instrument.js                     # Strike selection + expiry calculation
```

## Security

- **Login gate**: Cookie-based password (`LOGIN_SECRET`), 15-min sliding expiry, rate limiting (5 attempts/15 min/IP)
- **API secret**: Token required on all action routes (start/stop/exit/save)
- **Brute-force logging**: GPS + IP-API geolocation on failed login attempts
- **Crash recovery**: Position state persisted to disk with orphan detection + Telegram alert

## Tech Stack

- **Runtime**: Node.js + Express (HTTPS, self-signed cert)
- **Data Feed**: Fyers WebSocket (single connection, multi-mode fan-out)
- **Indicators**: `technicalindicators` (EMA, RSI, ADX, Parabolic SAR, Bollinger Bands)
- **Brokers**: Zerodha Kite Connect (primary) + Fyers API v3 (scalp + PA)
- **Notifications**: Telegram Bot API (configurable per-mode toggles)
- **Charts**: Chart.js (theme-aware)
- **Deployment**: PM2 on AWS EC2 t3.micro + GitHub Actions CI/CD
- **Caching**: Disk-based candle cache (backtest + live)

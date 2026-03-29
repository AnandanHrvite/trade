# Palani Andawar Trading Bot

NIFTY options algorithmic trading bot — Fyers (data + scalp orders) + Zerodha (live orders).

## Architecture

```
Fyers WebSocket (NIFTY50 spot ticks)
        |
   socketManager (singleton, multi-callback fan-out)
        |
   ┌────┴────────────────────────┐
   |                             |
 Main Mode (15-min)         Scalp Mode (3-min)
   |                             |
 ┌─┴─┐                       ┌──┴──┐
 |   |                       |     |
Live  Paper                 Live  Paper
Zerodha  Simulated         Fyers  Simulated
orders   orders            orders  orders
```

Both modes run **in parallel** on the same WebSocket — different candle resolutions, different brokers, independent risk controls.

## Modes

- **Backtest** — test strategy on historical data (realistic option P&L simulation)
- **Paper Trade** — run strategy on live data, simulate orders only
- **Live Trade** — real orders via Zerodha Kite (15-min, SAR+EMA9+RSI)
- **Manual Tracker** — register a manual Zerodha trade; bot trails the SL automatically
- **Scalp Live** — real orders via Fyers (3-min, EMA9 cross + RSI)
- **Scalp Paper** — scalp strategy on live data, simulated orders
- **Scalp Backtest** — scalp strategy on historical 3-min candles

### Parallel Compatibility

| | Live Trade | Paper Trade | Scalp Live | Scalp Paper |
|---|---|---|---|---|
| **Live Trade** | — | cannot | can | can |
| **Paper Trade** | cannot | — | can | can |
| **Scalp Live** | can | can | — | cannot |
| **Scalp Paper** | can | can | cannot | — |

Backtests always run independently.

## Strategies

### Strategy 1: SAR + EMA9 + RSI (15-min)
- **Entry**: EMA9 OHLC4 touch + SAR positioning + RSI momentum + ADX trend + EMA slope
- **Exit**: Tiered trailing SL + 50% candle rule + opposite signal + EOD
- **Filters**: ADX >= 25, VIX filter, body >= 10pt, SAR gap >= 55pt

### Strategy 2: Scalp EMA9 + RSI (3-min)
- **Entry**: EMA9 OHLC4 cross + close confirmation + RSI rising/falling + body >= 5pt
- **Exit**: Fixed target + fixed SL + trailing SL + RSI reversal + time stop (4 candles)
- **No SAR** — too laggy for 3-min candles

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

# 6. Open browser
https://YOUR_EC2_IP:3000
```

## Data Storage

All persistent data lives at `~/trading-data/` — **outside the project folder**.
`git pull` and redeployments never wipe your trade history or auth tokens.

```
~/trading-data/
  .fyers_token              # Fyers OAuth token
  .zerodha_token            # Zerodha OAuth token
  paper_trades.json         # Paper trade sessions
  live_trades.json          # Live trade sessions
  scalp_paper_trades.json   # Scalp paper sessions
  scalp_live_trades.json    # Scalp live sessions
  reports/                  # Daily trade reports
```

## Key .env Settings

### Main Strategy
| Key | Default | Notes |
|-----|---------|-------|
| `TRADE_RESOLUTION` | `15` | Candle size in minutes |
| `MAX_DAILY_LOSS` | `3000` | Daily kill-switch in INR |
| `MAX_DAILY_TRADES` | `10` | Daily entry cap |
| `LIVE_TRADE_ENABLED` | `false` | Must be `true` for Zerodha orders |
| `BACKTEST_OPTION_SIM` | `true` | Realistic option P&L (delta x theta) |

### Scalp Mode
| Key | Default | Notes |
|-----|---------|-------|
| `SCALP_ENABLED` | `false` | Must be `true` for Fyers scalp orders |
| `SCALP_RESOLUTION` | `3` | Scalp candle size (1/2/3/5 min) |
| `SCALP_SL_PTS` | `12` | Stop loss distance (pts) |
| `SCALP_TARGET_PTS` | `18` | Target distance (pts) |
| `SCALP_TRAIL_GAP` | `8` | Trail gap behind best price |
| `SCALP_TRAIL_AFTER` | `10` | Activate trail after N pts profit |
| `SCALP_TIME_STOP_CANDLES` | `4` | Exit if stuck (N candles) |
| `SCALP_MAX_DAILY_TRADES` | `30` | Daily scalp cap |
| `SCALP_MAX_DAILY_LOSS` | `2000` | Scalp kill-switch in INR |

### VIX Filter
| Key | Default | Notes |
|-----|---------|-------|
| `VIX_FILTER_ENABLED` | `true` | Block entries in high-VIX |
| `VIX_MAX_ENTRY` | `20` | Block all entries above this |
| `VIX_STRONG_ONLY` | `16` | Only STRONG signals above this |

## Routes

| URL | Description |
|-----|-------------|
| `/` | Dashboard |
| `/backtest` | Run backtest (15-min) |
| `/paperTrade/status` | Paper trade live view |
| `/paperTrade/history` | All past paper sessions |
| `/trade/status` | Live trade status |
| `/tracker/status` | Manual trade tracker |
| `/scalp-backtest` | Scalp backtest (3-min) |
| `/scalp-paper/status` | Scalp paper trade |
| `/scalp/status` | Scalp live trade |
| `/settings` | All config settings UI |
| `/logs` | Application logs |

## Project Structure

```
src/
  app.js                          # Express server, dashboard, routes
  strategies/
    strategy1_sar_ema_rsi.js      # Main 15-min strategy
    scalp_ema9_rsi.js             # Scalp 3-min strategy
  services/
    zerodhaBroker.js              # Zerodha order placement
    fyersBroker.js                # Fyers order placement (scalp)
    backtestEngine.js             # Historical candle engine
    vixFilter.js                  # VIX market regime filter
  routes/
    trade.js                      # Live trade (Zerodha)
    paperTrade.js                 # Paper trade (simulated)
    scalp.js                      # Scalp live (Fyers orders)
    scalpPaper.js                 # Scalp paper (simulated)
    scalpBacktest.js              # Scalp backtest (historical)
    backtest.js, settings.js, auth.js, logs.js, ...
  utils/
    socketManager.js              # WebSocket singleton + fan-out
    sharedSocketState.js          # Mode coexistence manager
    sharedNav.js                  # Sidebar navigation
    candleCache.js, nseHolidays.js, notify.js, ...
```

## Tech Stack

- **Runtime**: Node.js + Express (HTTPS, self-signed cert)
- **Data Feed**: Fyers WebSocket (fyersDataSocket singleton)
- **Indicators**: `technicalindicators` (EMA, RSI, ADX, Parabolic SAR)
- **Brokers**: Zerodha Kite Connect + Fyers API v3
- **Notifications**: Telegram Bot API
- **Deployment**: PM2 on AWS EC2 t2.micro

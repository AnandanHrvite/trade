# Palani Andawar Trading Bot

NIFTY options algorithmic trading bot — Fyers (data) + Zerodha (orders).

## Modes
- **Backtest** — test strategy on historical data (realistic option P&L simulation)
- **Paper Trade** — run strategy on live data, simulate orders only
- **Live Trade** — real orders via Zerodha Kite
- **Manual Tracker** — register a manual Zerodha trade; bot trails the SL automatically

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
node src/app.js

# 6. Open browser
https://YOUR_EC2_IP:3000
# (click Advanced → Proceed past self-signed cert warning)
```

## Data Storage
All persistent data lives at `~/trading-data/` — **outside the project folder**.
This means `git pull` and redeployments never wipe your paper trade history, live
trade history, or auth tokens. The bot auto-migrates old `./data/` files on first boot.

## Strategy
`SAR_EMA9_RSI` — 15-min NIFTY options
- Entry: EMA9 touch + SAR positioned + RSI momentum + ADX trend filter
- Exit: Tiered trailing SL + 50% candle rule + opposite signal + EOD 3:20PM

## Key .env Settings
| Key | Default | Notes |
|-----|---------|-------|
| `BACKTEST_OPTION_SIM` | `true` | Realistic option P&L (delta × theta) |
| `BACKTEST_DELTA` | `0.55` | Option delta (0.5 ATM, 0.65 ITM) |
| `BACKTEST_THETA_DAY` | `10` | ₹ theta decay per trading day |
| `TRADE_RESOLUTION` | `15` | Candle size in minutes |
| `MAX_DAILY_LOSS` | `5000` | Daily kill-switch in ₹ |
| `LIVE_TRADE_ENABLED` | `false` | Must be `true` for real orders |

## Routes
| URL | Description |
|-----|-------------|
| `/` | Dashboard |
| `/backtest` | Run backtest |
| `/paperTrade/status` | Paper trade live view |
| `/paperTrade/history` | All past sessions |
| `/tracker/status` | Manual trade tracker |
| `/trade/status` | Live trade status |
| `/logs` | Application logs |

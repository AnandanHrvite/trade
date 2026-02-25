# Fyers NIFTY Trading App

Node.js + Express trading app with Fyers API v3.
Supports **NIFTY Options** and **NIFTY Futures** intraday trading.
Includes backtest → compare → live trade workflow.

---

## Setup

```bash
npm install
cp .env.example .env
# Fill in your APP_ID and SECRET_KEY in .env
npm start
```

---

## Workflow

```
1. Login → 2. Backtest each strategy → 3. Compare → 4. Live Trade
```

### Step 1 — Login
```
GET  http://localhost:3000/auth/login
```
Redirects to Fyers. After login, access token is set automatically.

---

### Step 2 — Run Backtest (repeat for each strategy)

In `.env`, set:
```
ACTIVE_STRATEGY=STRATEGY_1
```
Then:
```
POST http://localhost:3000/backtest
Body: { "from": "2024-01-01", "to": "2024-06-30" }
```

Change to `STRATEGY_2`, run again. Then `STRATEGY_3`.

---

### Step 3 — Compare Results
```
GET  http://localhost:3000/result/compare
```
Returns win rate, PnL, drawdown, risk:reward for all 3 strategies.
Recommends the best one automatically.

---

### Step 4 — Go Live

In `.env`:
```
ACTIVE_STRATEGY=STRATEGY_1        ← set to your chosen winner
INSTRUMENT=NIFTY_OPTIONS          ← or NIFTY_FUTURES
LIVE_TRADE_ENABLED=true
```

Also update `src/config/instrument.js` daily:
```js
const NIFTY_SPOT_APPROX = 24000;  // today's approx NIFTY spot
const EXPIRY = "25JUN";           // current week/month expiry
```

Start:
```
POST http://localhost:3000/trade/start
```

Monitor:
```
GET  http://localhost:3000/trade/status
```

Stop:
```
POST http://localhost:3000/trade/stop
```

---

## Strategies

| Key | Name | Logic |
|-----|------|-------|
| STRATEGY_1 | EMA Crossover | 9 EMA crosses 21 EMA on 5-min candles |
| STRATEGY_2 | RSI + VWAP Reversal | RSI < 35 or > 65 + VWAP crossover |
| STRATEGY_3 | Supertrend Momentum | Supertrend (10,3) direction flip |

---

## ENV Toggles

| Variable | Options | Description |
|----------|---------|-------------|
| `ACTIVE_STRATEGY` | `STRATEGY_1` / `STRATEGY_2` / `STRATEGY_3` | Which strategy to use |
| `INSTRUMENT` | `NIFTY_OPTIONS` / `NIFTY_FUTURES` | What to trade |
| `LIVE_TRADE_ENABLED` | `true` / `false` | Safety switch for live trading |
| `LOT_MULTIPLIER` | `1`, `2`, etc. | Number of lots (1 lot = 50 qty for NIFTY) |
| `BACKTEST_FROM` | `YYYY-MM-DD` | Backtest start date |
| `BACKTEST_TO` | `YYYY-MM-DD` | Backtest end date |
| `BACKTEST_CAPITAL` | number | Starting capital for simulation |

---

## Important Notes

- **Options backtest uses NIFTY50-INDEX** as proxy since historical option chain data
  is limited. For exact premium backtesting you'd need a data vendor.
- **Daily setup**: Update `NIFTY_SPOT_APPROX` and `EXPIRY` in `instrument.js` before market open.
- **EOD square-off**: All positions are automatically closed at 3:20 PM IST.
- **1 lot = 50 qty** for NIFTY (as per current lot size).

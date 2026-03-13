# 🪔 Palani Andawar Trading App

**Palani Andawar thunai** — A local-only Node.js + Express trading bot for NIFTY Options and Futures.
Uses **Fyers API v3** for all market data (WebSocket ticks, REST quotes, candle history)
and **Zerodha Kite Connect** exclusively for live order placement.

---

## Architecture

```
App (127.0.0.1 only)
 ├── Fyers API v3        — market data: WebSocket spot ticks, REST quotes, historical candles
 ├── Zerodha Kite Connect — order placement: live trades only (never used in paper/backtest)
 ├── Strategy Engine     — auto-discovered from src/strategies/
 ├── Paper Trade         — simulated orders on live data (no Zerodha)
 ├── Live Trade          — real orders via Zerodha on live Fyers data
 └── Backtest            — historical candle replay via Fyers REST
```

---

## Modes

| Mode | Data | Orders | URL |
|------|------|--------|-----|
| Backtest | Fyers REST candles | None | `/backtest` |
| Paper Trade | Fyers WebSocket (live) | Simulated (in-memory) | `/paperTrade/start` |
| Live Trade | Fyers WebSocket (live) | Real — Zerodha | `/trade/start` |

Paper and Live trade cannot run simultaneously — a shared socket guard prevents it.

---

## Active Strategy — STRATEGY_1 (SAR + EMA9 + RSI)

### Entry — BUY_CE (Bullish)
- Candle HIGH touches or crosses EMA9 intra-candle (`candle.high >= ema9`)
- SAR trend = 1 (uptrend — dots below price)
- RSI > 55 (bullish momentum)
- EMA9 slope rising ≥ 6 pts vs previous candle
- Stop Loss: current SAR dot value (below price)

### Entry — BUY_PE (Bearish)
- Candle LOW touches or crosses EMA9 intra-candle (`candle.low <= ema9`)
- SAR trend = −1 (downtrend — dots above price)
- RSI < 45 (bearish momentum)
- EMA9 slope falling ≥ 6 pts vs previous candle
- Stop Loss: current SAR dot value (above price)

### Entry timing
- Intra-candle (tick-level): 5-min resolution, or 15-min when bar high/low changes
- Candle-close fallback: fires if intra-candle entry was missed (confirmed signal)
- Trading window: 9:15 AM → 3:20 PM IST (no new entries in last 10 min before stop)

### Exit Rules (all modes)
1. **50% Candle Rule** — if a subsequent candle low (CE) / high (PE) crosses the mid of the candle at entry time → exit at that mid-price. Skip check on entry candle itself.
2. **SAR Trailing SL** — updated each candle close. Only tightens, never widens. CE: higher SAR; PE: lower SAR.
3. **Intra-candle Points Trail** — activates after `TRAIL_ACTIVATE_PTS` gain, then trails `TRAIL_GAP` pts behind best price.
4. **Opposite Signal Exit** — if strategy generates the opposite signal, exit current position.
5. **EOD Square-Off** — automatically squares off all positions at `TRADE_STOP_TIME` (default 3:30 PM IST).

---

## Token Management

### Fyers
- Token saved to `data/.fyers_token` with the IST calendar date (`savedDate`).
- On every app startup: if `savedDate ≠ today (IST)` → token deleted, fresh login required.
- Fallback: if token age > 20 hours → also deleted.

### Zerodha
- Token saved to `data/.zerodha_token` with `validated: true` only after real OAuth callback.
- Same date-based expiry: if `savedDate ≠ today (IST)` → token deleted, fresh login required.
- Fallback: if token age > 20 hours → also deleted.

### EOD Auto-Clear (3:31 PM IST daily)
- `app.js` schedules a timer at startup that fires at **3:31 PM IST every day**.
- Calls `clearFyersToken()` and `zerodha.clearZerodhaToken()` — wipes both token files.
- Re-schedules itself for the same time the next day (perpetual, no cron needed).
- Ensures tokens are cleared even if no manual stop is done.
- **Result:** Next morning when you start the app, no stale tokens are loaded → forced fresh login for both brokers before trading begins.

---

## Setup

### 1. Install
```bash
npm install
```

### 2. Environment
Copy `.env.example` to `.env` and fill in:
```env
# Fyers
APP_ID=your_fyers_app_id
APP_SECRET=your_fyers_app_secret
REDIRECT_URL=http://localhost:3000/auth/callback

# Zerodha (optional — only for live trade)
ZERODHA_API_KEY=your_zerodha_key
ZERODHA_API_SECRET=your_zerodha_secret

# Trading parameters
INSTRUMENT=NIFTY_OPTIONS        # NIFTY_OPTIONS | NIFTY_FUTURES
TRADE_RESOLUTION=15             # candle interval in minutes (5 or 15)
TRADE_START_TIME=09:15          # no entries before this time
TRADE_STOP_TIME=15:30           # auto-stop + EOD square-off at this time

# Risk controls
MAX_DAILY_LOSS=5000             # daily loss kill switch (₹)
MAX_DAILY_TRADES=20             # max trades per session
TRAIL_GAP_PTS=60                # trailing SL gap (pts)
TRAIL_ACTIVATE_PTS=15           # activate trail after this gain (pts)
OPT_STOP_PCT=0.20               # option premium stop: exit if premium drops 20%

# Paper trade
PAPER_TRADE_CAPITAL=100000      # starting capital for paper trade

# Security (localhost only — mainly prevents accidental browser hits)
API_SECRET=your_secret_here

# Live trade gate (set true only when ready)
LIVE_TRADE_ENABLED=false

# Telegram (optional)
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
```

### 3. Run
```bash
npm start          # production
npm run dev        # development with nodemon
```

App runs at `http://localhost:3000` (bound to 127.0.0.1 only — not accessible from network).

---

## Routes

### Dashboard
| Route | Description |
|-------|-------------|
| `GET /` | Main dashboard — broker status, backtest launcher, links |
| `GET /auth/login` | Fyers OAuth login |
| `GET /auth/callback` | Fyers OAuth callback |
| `GET /auth/zerodha/login` | Zerodha OAuth login |
| `GET /auth/zerodha/callback` | Zerodha OAuth callback |
| `GET /auth/zerodha/logout` | Clear Zerodha token |
| `GET /auth/status` | Auth status JSON |

### Paper Trade
| Route | Description |
|-------|-------------|
| `GET /paperTrade/start` | Start paper trading session |
| `GET /paperTrade/stop` | Stop session, save to disk |
| `GET /paperTrade/status` | Live status page (auto-refreshes) |
| `GET /paperTrade/history` | All past paper trade sessions |
| `GET /paperTrade/debug` | Debug state JSON |
| `GET /paperTrade/reset` | Wipe history, reset capital |
| `GET /paperTrade/exit` | Manual exit current position |
| `GET /paperTrade/export-csv` | Download session trades as CSV |

### Live Trade
| Route | Description |
|-------|-------------|
| `GET /trade/start` | Start live trading session |
| `GET /trade/stop` | Stop session, square off via Zerodha |
| `GET /trade/status` | Live status page (auto-refreshes 2s) |
| `GET /trade/status/data` | AJAX JSON data for live status page |
| `GET /trade/exit` | Manual exit current position via Zerodha |

### Backtest & Results
| Route | Description |
|-------|-------------|
| `GET /backtest?from=YYYY-MM-DD&to=YYYY-MM-DD&resolution=15` | Run backtest |
| `GET /result` | Latest backtest result |
| `GET /result/all` | All saved results |

---

## File Structure

```
src/
├── app.js                      — Express app, routes, security, EOD token scheduler
├── config/
│   ├── fyers.js                — Fyers SDK init, token persistence + date-based expiry
│   └── instrument.js           — Auto strike/expiry calculation, lot size
├── routes/
│   ├── auth.js                 — OAuth flows for Fyers and Zerodha
│   ├── trade.js                — Live trading engine (Zerodha orders)
│   ├── paperTrade.js           — Paper trading engine (simulated orders)
│   ├── backtest.js             — Backtest runner
│   └── result.js               — Backtest result store/display
├── services/
│   ├── backtestEngine.js       — Fyers candle fetch + historical replay
│   └── zerodhaBroker.js        — Zerodha Kite Connect wrapper + token management
├── strategies/
│   ├── index.js                — Strategy auto-discovery + active selector
│   └── strategy1_sar_ema_rsi.js — SAR + EMA9 + RSI strategy
└── utils/
    ├── socketManager.js        — Fyers WebSocket wrapper (robust reconnect)
    ├── sharedSocketState.js    — Prevents paper + live from running simultaneously
    ├── notify.js               — Telegram notifications
    ├── resultStore.js          — Save/load backtest results
    └── time.js                 — Date/timestamp helpers

data/                           — Runtime data (created automatically)
├── .fyers_token                — Fyers access token (date-stamped)
├── .zerodha_token              — Zerodha access token (date-stamped, validated flag)
├── paper_trades.json           — Paper trade history + capital
└── live_trades.json            — Live trade session history

logs/                           — Fyers SDK log directory (auto-created)
```

---

## Instrument Config (`src/config/instrument.js`)

- `INSTRUMENT=NIFTY_OPTIONS` — trades nearest weekly Thursday expiry CE/PE
- `INSTRUMENT=NIFTY_FUTURES` — trades current month futures (CE=LONG, PE=SHORT)
- Strike: fetched live from Fyers (`NSE:NIFTY50-INDEX` LTP rounded to nearest 50)
- `STRIKE_OFFSET=0` → ATM, `STRIKE_OFFSET=50` → 1 OTM, `STRIKE_OFFSET=-50` → 1 ITM
- Symbol validated against Fyers before entry — if next week not live yet, entry is blocked
- Pre-fetches CE+PE symbols after each candle close so entry has zero REST delay

---

## Safety Guards

| Guard | Description |
|-------|-------------|
| `_entryPending` | 4-second lock prevents duplicate entries on rapid ticks |
| `_slHitCandleTime` | Blocks re-entry on the same candle where SL/50%-rule exit fired |
| `_orderInFlight` | 5-second lock prevents duplicate Zerodha order placement |
| `_squareOffInFlight` | Prevents concurrent exit calls when multiple SL ticks arrive |
| `_dailyLossHit` | Hard kill switch: no entries after session loss ≥ `MAX_DAILY_LOSS` |
| `_consecutiveLosses` | After 3 back-to-back losses: 15-min → day kill; 5-min → 20-min pause |
| `_fiftyPctPauseUntil` | After 50%-rule exit: pause 2 candles (market was choppy) |
| `MAX_DAILY_TRADES` | Cap on total trades per session |
| `sharedSocketState` | Paper + Live cannot run simultaneously |
| `LIVE_TRADE_ENABLED` | Live trading disabled by default in `.env` |
| 50% entry gate | Entry blocked if spot is already on wrong side of prev-candle mid (no directional room) |

---

## Performance Notes

- `isMarketHours()` is cached with a 60-second TTL in both `trade.js` and `paperTrade.js`. The function creates a `Date` object — at 100-200 NIFTY ticks/min, caching it cuts overhead to once per minute.
- For 15-min resolution, the signal check (`getSignal`) is throttled to only run when the live bar's `high` or `low` actually changes — avoids running the full EMA/RSI/SAR stack on every tick.
- Option symbols (CE + PE) are pre-fetched in the background after each candle close so that when an entry signal fires on the next tick, the Fyers symbol is already resolved (no REST call delay at entry).
- `_cachedClosedCandleSL` stores the SAR stop-loss from the last fully closed candle, used on every tick without re-running the strategy.
- All `require()` calls are at module top-level (no inline `require` inside hot paths).

---

## Morning Login Flow

1. Start the app: `npm start` (or `npm run dev`)
2. Open `http://localhost:3000`
3. Click **Login with Fyers** → complete OAuth → token saved to `data/.fyers_token`
4. *(Live trade only)* Click **Login with Zerodha** → complete OAuth → token saved to `data/.zerodha_token`
5. Start Paper or Live trade from the dashboard

The app will show "Token restored from disk" on subsequent starts **on the same day**. On the next calendar day (IST), the date-based check wipes the token and forces a fresh login.

---

## Telegram Notifications

Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` in `.env` to receive:
- Entry alerts (side, symbol, strike, spot, option LTP, stop loss)
- Exit alerts (exit reason, PnL, session PnL)

Leave blank to disable Telegram (app works normally without it).

require("dotenv").config();
const fyers = require("../config/fyers");
const { toDateString } = require("../utils/time");

/**
 * Fyers max days per request depending on resolution:
 *   1-min  → 30 days
 *   2-min  → 30 days
 *   3-min  → 30 days
 *   5-min  → 100 days
 *   10-min → 100 days
 *   15-min → 100 days
 *   30-min → 100 days
 *   60-min → 100 days
 *   D/W/M  → unlimited (use full range)
 */
function maxDaysForResolution(resolution) {
  if (["D", "W", "M"].includes(resolution)) return 365 * 10; // effectively no limit
  if (["1", "2", "3"].includes(String(resolution))) return 30;
  return 100; // 5, 10, 15, 30, 60-min
}

/**
 * Sleep helper to avoid hitting Fyers rate limits between chunk requests
 */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Fetch a SINGLE chunk of historical OHLCV from Fyers
 * All values must be strings — Fyers v3 is strict about types
 */
async function fetchChunk(symbol, resolution, from, to) {
  const params = {
    symbol:      symbol,
    resolution:  String(resolution),
    date_format: "1",          // "1" = YYYY-MM-DD string dates (NOT unix), "0" = unix timestamps
    range_from:  from,         // "YYYY-MM-DD"
    range_to:    to,           // "YYYY-MM-DD"
    cont_flag:   "1",          // must be string "1"
  };

  console.log(`   📦 Fetching chunk: ${from} → ${to}`);
  const response = await fyers.getHistory(params);

  if (response.s !== "ok") {
    throw new Error(`Fyers API error: ${JSON.stringify(response)}`);
  }

  if (!response.candles || response.candles.length === 0) {
    return []; // no data for this range (e.g. holiday period)
  }

  // Fyers returns [timestamp, open, high, low, close, volume]
  return response.candles.map(([time, open, high, low, close, volume]) => ({
    time, open, high, low, close, volume,
  }));
}

/**
 * Fetch historical OHLCV candles from Fyers
 * Automatically splits large date ranges into chunks to stay within Fyers limits
 *
 * @param {string} symbol      - e.g. "NSE:NIFTY50-INDEX"
 * @param {string} resolution  - "1","5","15","60","D","W","M"
 * @param {string} from        - "YYYY-MM-DD"
 * @param {string} to          - "YYYY-MM-DD"
 */
async function fetchCandles(symbol, resolution, from, to) {
  const maxDays = maxDaysForResolution(resolution);
  const allCandles = [];

  let cursor = new Date(from);
  const endDate = new Date(to);

  while (cursor <= endDate) {
    // Calculate chunk end date
    const chunkEnd = new Date(cursor);
    chunkEnd.setDate(chunkEnd.getDate() + maxDays - 1);
    if (chunkEnd > endDate) chunkEnd.setTime(endDate.getTime());

    const chunkFrom = cursor.toISOString().split("T")[0];
    const chunkTo   = chunkEnd.toISOString().split("T")[0];

    const candles = await fetchChunk(symbol, resolution, chunkFrom, chunkTo);
    allCandles.push(...candles);

    // Move cursor to next chunk
    cursor = new Date(chunkEnd);
    cursor.setDate(cursor.getDate() + 1);

    // Wait 300ms between requests to respect rate limits
    if (cursor <= endDate) await sleep(300);
  }

  // Deduplicate by timestamp (in case chunks overlap at boundaries)
  const seen = new Set();
  const unique = allCandles.filter((c) => {
    if (seen.has(c.time)) return false;
    seen.add(c.time);
    return true;
  });

  // Sort ascending by time
  unique.sort((a, b) => a.time - b.time);

  console.log(`   ✅ Total candles fetched: ${unique.length}`);
  return unique;
}

/**
 * Run the active strategy over historical candles
 * Returns a list of simulated trades
 */
function runBacktest(candles, strategy, capital) {
  const trades = [];
  let position = null;
  const BROKERAGE = 40; // ₹20 per side × 2

  let pendingEntry = null; // signal fired on candle N → enter at open of candle N+1

  for (let i = 25; i < candles.length; i++) {
    const window = candles.slice(0, i + 1);
    const { signal, reason, stopLoss: signalSL, ...indicators } = strategy.getSignal(window);
    const candle = candles[i];
    const isLastCandle = i === candles.length - 1;

    // ── PENDING ENTRY — enter at this candle's OPEN (signal fired last candle) ──
    // Signal detected on previous candle close → realistic order fill at next open
    if (pendingEntry && !position) {
      position = {
        side:        pendingEntry.side,
        entryPrice:  candle.open,          // ← next candle open (not signal candle close)
        entryTime:   candle.time,
        entryReason: pendingEntry.reason,
        stopLoss:    pendingEntry.stopLoss || null,
        indicators:  pendingEntry.indicators,
      };
      pendingEntry = null;
    }

    // ── EXIT check ───────────────────────────────────────────────
    if (position) {
      const oppositeSignal = position.side === "CE" ? "BUY_PE" : "BUY_CE";
      let exitReason = null;
      let exitPrice  = candle.close;

      // Dynamic SL update — SAR trails with each candle
      if (signalSL !== null && signalSL !== undefined) {
        position.stopLoss = signalSL;
      }

      // 1. Stoploss hit — candle closes beyond SL
      if (position.stopLoss !== null && position.stopLoss !== undefined) {
        if (position.side === "CE" && candle.close < position.stopLoss) {
          exitReason = `Stoploss hit — candle closed @ ${candle.close} below SL ${position.stopLoss}`;
          exitPrice  = candle.close;
        } else if (position.side === "PE" && candle.close > position.stopLoss) {
          exitReason = `Stoploss hit — candle closed @ ${candle.close} above SL ${position.stopLoss}`;
          exitPrice  = candle.close;
        }
      }

      // 2. Opposite signal
      if (!exitReason && signal === oppositeSignal) {
        exitReason = "Opposite signal exit";
      }

      // 3. EOD square-off
      if (!exitReason && isLastCandle) {
        exitReason = "EOD square-off";
      }

      if (exitReason) {
        const rawPnl = (exitPrice - position.entryPrice) * (position.side === "CE" ? 1 : -1);
        const pnl    = parseFloat((rawPnl - BROKERAGE).toFixed(2));

        trades.push({
          side:        position.side,
          entryTime:   toDateString(position.entryTime),
          exitTime:    toDateString(candle.time),
          entryPrice:  position.entryPrice,
          exitPrice,
          stopLoss:    position.stopLoss || "N/A",
          pnl,
          exitReason,
          entryReason: position.entryReason,
          indicators:  position.indicators,
        });

        position = null;
      }
    }

    // ── QUEUE ENTRY for next candle open ─────────────────────────
    // Don't enter now — store as pending, fill at next candle's open
    if (!position && !pendingEntry && signal !== "NONE" && !isLastCandle) {
      const side = signal === "BUY_CE" ? "CE" : "PE";
      pendingEntry = {
        side,
        reason,
        stopLoss:   signalSL || null,
        indicators,
      };
    }
  }

  // ── SUMMARY ────────────────────────────────────────────────────
  const totalPnl = trades.reduce((sum, t) => sum + t.pnl, 0);
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const maxDrawdown = trades.reduce((dd, t) => Math.min(dd, t.pnl), 0);
  const avgWin = wins.length ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0;
  const riskReward = avgLoss !== 0 ? Math.abs(avgWin / avgLoss) : null;

  return {
    summary: {
      strategy: strategy.NAME,
      description: strategy.DESCRIPTION,
      totalTrades: trades.length,
      wins: wins.length,
      losses: losses.length,
      winRate: trades.length ? `${((wins.length / trades.length) * 100).toFixed(1)}%` : "N/A",
      totalPnl: parseFloat(totalPnl.toFixed(2)),
      maxDrawdown: parseFloat(maxDrawdown.toFixed(2)),
      avgWin: parseFloat(avgWin.toFixed(2)),
      avgLoss: parseFloat(avgLoss.toFixed(2)),
      riskReward: riskReward ? riskReward.toFixed(2) : "N/A",
      finalCapital: parseFloat((capital + totalPnl).toFixed(2)),
    },
    trades,
  };
}

module.exports = { fetchCandles, runBacktest };

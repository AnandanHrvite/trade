/**
 * Crash-safe per-trade JSONL logger.
 *
 * Why: session summaries in *_paper_trades.json are only flushed at EOD / stop,
 * so a mid-session server crash loses every trade taken today. This logger
 * appends one JSON line per completed trade the moment it exits, to a
 * separate file. Append-only writes cannot corrupt earlier lines — at worst
 * the in-flight line is truncated, and any reader can skip a bad line.
 *
 * Files land in ~/trading-data/ alongside the existing JSON summaries.
 */

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const _HOME = require("os").homedir();
const DATA_DIR = path.join(_HOME, "trading-data");

const FILE_BY_MODE = {
  swing: "paper_trades_log.jsonl",
  scalp: "scalp_paper_trades_log.jsonl",
  pa:    "pa_paper_trades_log.jsonl",
};

// One-time dir ensure at module load — keeps the hot-path append sync-free.
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) {}

function filePathFor(mode) {
  const name = FILE_BY_MODE[mode];
  if (!name) throw new Error(`tradeLogger: unknown mode "${mode}"`);
  return path.join(DATA_DIR, name);
}

function appendTradeLog(mode, trade) {
  try {
    const line = JSON.stringify({ mode, loggedAt: new Date().toISOString(), ...trade }) + "\n";
    // Fire-and-forget async append. POSIX O_APPEND makes each short write
    // atomic, so concurrent exits cannot interleave lines.
    fsp.appendFile(filePathFor(mode), line).catch(err => {
      console.warn(`[tradeLogger] append failed (mode=${mode}): ${err.message}`);
    });
  } catch (err) {
    // Logging must never break the trade flow.
    console.warn(`[tradeLogger] append failed (mode=${mode}): ${err.message}`);
  }
}

module.exports = { appendTradeLog, filePathFor, FILE_BY_MODE };

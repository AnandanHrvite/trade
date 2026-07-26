/**
 * boundedExit.js — bound how long a live square-off may be waited on
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 *
 * Paper's exit is synchronous, so a paper `stopSession()` always finishes with the
 * trade already in `sessionTrades` and `sessionPnl` final. A LIVE exit is a broker
 * round-trip. Firing it un-awaited (which every live route used to do) let the
 * session be saved WITHOUT its final trade — real money missing from the books.
 *
 * Awaiting fixes that, but introduces the opposite failure: neither the Fyers nor
 * the Zerodha SDK sets an HTTP timeout, and axios defaults to none. A dead broker
 * socket can therefore hang until OS keepalive gives up — minutes. Awaiting it
 * unbounded would hang the `/stop` request, and stall `gracefulShutdown` on a
 * deploy while PM2 waits to SIGKILL.
 *
 * So: wait, but with a ceiling.
 *
 * WHAT THE TIMEOUT DOES *NOT* DO — it does not cancel anything. A market order that
 * has left the process cannot be recalled; the timeout only stops us WAITING. The
 * order may still fill afterwards, which is exactly why the alert says "verify on
 * the dashboard" rather than "exit failed".
 *
 * The default ceiling is deliberately generous. A healthy order round-trip is well
 * under a second, so 20s never fires in normal operation — books stay correct. It
 * fires only in a genuine outage, where a loud alert is precisely what the operator
 * needs, and where continuing to bookkeeping (with the trade possibly absent) is
 * still better than a hung process holding an open position nobody is told about.
 */

const FALLBACK_TIMEOUT_MS = 20000;

/**
 * The configured ceiling, read LIVE on every call — never cached at module load.
 * Settings writes to process.env and expects changes to apply without a restart,
 * which is how every other config read in this repo behaves.
 *
 * A malformed value (`LIVE_EXIT_WAIT_MS=abc`) falls back to the default rather than
 * disabling the ceiling. Silently removing a safety limit because someone fat-
 * fingered a setting is exactly the wrong direction; only an explicit `0` opts out.
 */
function _configuredTimeoutMs() {
  const raw = process.env.LIVE_EXIT_WAIT_MS;
  if (raw === undefined || raw === null || String(raw).trim() === "") return FALLBACK_TIMEOUT_MS;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) {
    console.warn(`[boundedExit] LIVE_EXIT_WAIT_MS="${raw}" is not a number — using ${FALLBACK_TIMEOUT_MS}ms`);
    return FALLBACK_TIMEOUT_MS;
  }
  return n;   // 0 (or negative) = explicit opt-out, honoured below
}

/**
 * Await a live square-off with a ceiling on the wait.
 *
 * Resolves when the exit completes. Rejects if the exit itself rejects, or if the
 * ceiling is reached first — callers already treat both as "exit not confirmed" and
 * log/alert accordingly.
 *
 * @param {Promise} exitPromise  the in-flight squareOff()/placeLiveSell() promise
 * @param {string}  label        mode tag for the message, e.g. "BB_RSI-LIVE"
 * @param {number}  [timeoutMs]  override the ceiling (tests use a small value)
 * @returns {Promise<*>}
 */
function awaitExit(exitPromise, label, timeoutMs) {
  const ms = Number.isFinite(timeoutMs) ? timeoutMs : _configuredTimeoutMs();
  if (!(ms > 0)) return Promise.resolve(exitPromise);   // explicit 0 = wait forever

  let timer = null;
  let ceilingFired = false;

  // If the ceiling wins the race, `exitPromise` keeps running unobserved — and a
  // later rejection on it would surface as an unhandled promise rejection (which
  // this process treats as fatal). Attach a terminal handler now. It only LOGS when
  // the ceiling already fired; when the exit lost on its own merits the caller is
  // receiving that rejection directly and does not need it reported twice.
  exitPromise.catch(err => {
    if (ceilingFired) {
      console.error(`[${label}] square-off finally settled with an error, after the wait ceiling had already passed: ${err && err.message}`);
    }
  });

  const ceiling = new Promise((_, reject) => {
    timer = setTimeout(() => {
      ceilingFired = true;
      reject(new Error(
        `[${label}] exit NOT CONFIRMED within ${Math.round(ms / 1000)}s — the order may still be in flight. ` +
        `Verify the broker dashboard; the saved session may be missing this trade.`
      ));
    }, ms);
    // Never hold the event loop open just for this watchdog.
    if (timer && typeof timer.unref === "function") timer.unref();
  });

  return Promise.race([exitPromise, ceiling]).finally(() => { if (timer) clearTimeout(timer); });
}

module.exports = { awaitExit, FALLBACK_TIMEOUT_MS, _configuredTimeoutMs };

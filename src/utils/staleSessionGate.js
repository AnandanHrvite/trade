/**
 * Trading-day gate for the paper pages' "last session" fallback.
 *
 * Every paper route rehydrates its Session Trades on boot (rehydrateSessionFromJsonl).
 * When today's day-file holds no trades it falls back to the most recent SAVED
 * session so the screen isn't blank after a restart, and flags it `_staleSession`.
 *
 * That fallback is only wanted while the market is SHUT: on a Saturday it is genuinely
 * useful to still see Friday's result. On a TRADING day it is wrong — a restart before
 * the day's first trade resurrects yesterday's trades and, because chartBackfill follows
 * the restored trades' day, yesterday's CHART with them. The page then shows a complete,
 * self-consistent, and entirely wrong session (observed on ORB Paper, 2026-08-06: today's
 * session had run with no trades, so the page showed 5-Aug trades over a 5-Aug chart).
 *
 * Call once per route immediately after rehydrate. Async because NSE holidays come from
 * the (cached) holiday list; any failure leaves the restored session untouched, i.e. the
 * old, more forgiving behaviour.
 */

const { isNonTradingDay } = require("./nseHolidays");

/**
 * @param {() => object} getState  getter for the route's live state object — a getter,
 *                                 not the object, because /start reassigns `state`.
 * @param {string} tag             log prefix, e.g. "[ORB-PAPER]"
 */
async function clearStaleSessionOnTradingDay(getState, tag) {
  try {
    const before = getState();
    if (!before || !before._staleSession) return;
    if (await isNonTradingDay(new Date())) return; // weekend / NSE holiday → keep it on screen

    // Re-check after the await — a session may have been started in the meantime,
    // in which case /start already reset the state and there is nothing stale left.
    const st = getState();
    if (!st || !st._staleSession || st.running) return;
    st._staleSession = false;
    st.sessionTrades = [];
    st.tradesTaken   = 0;
    st.sessionPnl    = 0;
    st.sessionStart  = null;
    console.log(`♻️ ${tag} Previous-day session cleared — today is a trading day, so only today's session is shown`);
  } catch (_) {
    /* best-effort: on any failure keep whatever was restored */
  }
}

module.exports = { clearStaleSessionOnTradingDay };

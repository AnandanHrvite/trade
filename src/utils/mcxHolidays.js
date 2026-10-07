/**
 * mcxHolidays.js — "is MCX shut right now?" from what the exchange printed,
 * not from a calendar.
 * ─────────────────────────────────────────────────────────────────────────────
 * The repo has no MCX holiday source: nseHolidays.js reads NSE's equity list,
 * and MCX differs from it — on many NSE holidays MCX still runs its evening
 * session (17:00 onwards), on a few it is shut all day. Reusing the NSE list
 * would block valid MCX sessions, so instead the commodity engine asks the
 * market itself: if the signal future has printed NO candle and NO trade since
 * the latest session open, well past that open, the session is not running.
 *
 * Safe direction: anything that shows activity since the open (a closed bar,
 * a quote's trade time / last-minute candle) vetoes "closed". Missing data
 * never adds evidence of closure — only the absence of today's bars does, and
 * a front-month MCX future does not go a full grace window without a trade.
 * ─────────────────────────────────────────────────────────────────────────────
 */

// MCX's evening session start — the half-holiday case (morning shut, evening open).
const EVENING_OPEN_MIN = 17 * 60;

function _istMidnightSec(ms) {
  const istSec = Math.floor((ms + 19800000) / 1000);
  return istSec - (istSec % 86400) - 19800;
}

/**
 * mcxSessionClosed({ nowMs, sessStartMin, sessEndMin, resMin, lastBarTimeSec, quoteTradeSec })
 *   nowMs          current time (ms)
 *   sessStartMin   configured session open, IST minutes since midnight
 *   sessEndMin     configured session close, IST minutes
 *   resMin         candle size — the grace must cover two closed bars
 *   lastBarTimeSec open time of the newest CLOSED bar we hold (null = none)
 *   quoteTradeSec  newest exchange time from a quote (tt / last-minute candle), or null
 * Returns { closed:false } or { closed:true, openMin, untilMs } — untilMs is the
 * next session open today (evening) or the next IST midnight.
 */
function mcxSessionClosed({ nowMs, sessStartMin, sessEndMin, resMin = 5, lastBarTimeSec = null, quoteTradeSec = null }) {
  const midSec = _istMidnightSec(nowMs);
  const nowMin = Math.floor((nowMs / 1000 - midSec) / 60);
  const opens = [sessStartMin];
  if (EVENING_OPEN_MIN > sessStartMin && EVENING_OPEN_MIN < sessEndMin) opens.push(EVENING_OPEN_MIN);

  const openMin = opens.filter((o) => o <= nowMin).pop();
  if (openMin == null || nowMin >= sessEndMin) return { closed: false };
  const grace = Math.max(15, 2 * Math.max(1, resMin));
  if (nowMin < openMin + grace) return { closed: false };           // too early to tell

  const openSec = midSec + openMin * 60;
  if (Number.isFinite(lastBarTimeSec) && lastBarTimeSec >= openSec) return { closed: false };
  if (Number.isFinite(quoteTradeSec) && quoteTradeSec >= openSec) return { closed: false };

  const nextOpen = opens.find((o) => o > openMin);
  const untilMs = (nextOpen != null ? midSec + nextOpen * 60 : midSec + 86400) * 1000;
  return { closed: true, openMin, untilMs };
}

/** In the first grace window after a session open — too early to judge. */
function inOpenGrace({ nowMs, sessStartMin, sessEndMin, resMin = 5 }) {
  const nowMin = Math.floor((nowMs / 1000 - _istMidnightSec(nowMs)) / 60);
  const grace = Math.max(15, 2 * Math.max(1, resMin));
  const opens = [sessStartMin];
  if (EVENING_OPEN_MIN > sessStartMin && EVENING_OPEN_MIN < sessEndMin) opens.push(EVENING_OPEN_MIN);
  return opens.some((o) => nowMin >= o && nowMin < o + grace);
}

/** Newest exchange time (unix sec) in a Fyers quote's `v`, or null. */
function quoteTradeSec(v) {
  if (!v) return null;
  const cands = [parseInt(v.tt, 10), v.cmd && parseInt(v.cmd.t, 10)].filter((n) => Number.isFinite(n) && n > 0);
  return cands.length ? Math.max(...cands) : null;
}

module.exports = { mcxSessionClosed, inOpenGrace, quoteTradeSec, EVENING_OPEN_MIN };

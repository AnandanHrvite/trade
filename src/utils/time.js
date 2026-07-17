/**
 * Convert unix timestamp (seconds) to readable date string
 */
function toDateString(unixSec) {
  const ist = new Date(unixSec * 1000 + 19800000);
  const dd = String(ist.getUTCDate()).padStart(2, '0');
  const mm = String(ist.getUTCMonth() + 1).padStart(2, '0');
  const yyyy = ist.getUTCFullYear();
  const h = String(ist.getUTCHours()).padStart(2, '0');
  const m = String(ist.getUTCMinutes()).padStart(2, '0');
  const s = String(ist.getUTCSeconds()).padStart(2, '0');
  return `${dd}/${mm}/${yyyy}, ${h}:${m}:${s}`;
}

/**
 * Convert "YYYY-MM-DD" to unix timestamp (seconds)
 */
function toTimestamp(dateStr) {
  return Math.floor(new Date(dateStr).getTime() / 1000);
}

/**
 * Get today's date as "YYYY-MM-DD" in IST (Asia/Kolkata, UTC+5:30).
 * Using the raw UTC date would roll back to the previous day between
 * 00:00–05:30 IST, mis-bucketing trades/logs near midnight.
 */
function today() {
  const ist = new Date(Date.now() + 19800000);
  return ist.toISOString().split("T")[0];
}

module.exports = { toDateString, toTimestamp, today };

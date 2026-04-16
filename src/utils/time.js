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
 * Get today's date as "YYYY-MM-DD"
 */
function today() {
  return new Date().toISOString().split("T")[0];
}

module.exports = { toDateString, toTimestamp, today };

/**
 * Convert unix timestamp (seconds) to readable date string
 */
function toDateString(unixSec) {
  return new Date(unixSec * 1000).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
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

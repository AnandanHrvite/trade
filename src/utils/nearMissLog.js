/**
 * Near-miss entry logger (additive-only — does NOT affect trade decisions).
 *
 * Reads `result.filterAudit` produced by the strategy layer (see
 * strategy1_sar_ema_rsi.js / scalp_bb_cpr.js). When a candle was skipped but
 * exactly one filter failed on either side, emit a compact "missed by one"
 * line so the data-collection window surfaces the opportunity cost of each
 * individual filter.
 *
 * Threshold is `maxMissing` (default 1). Setting to 2 would also log when
 * two filters missed; keep at 1 for noise-free signal.
 */
function logNearMiss(audit, tag, log, opts) {
  if (!audit) return;
  opts = opts || {};
  var maxMissing = typeof opts.maxMissing === "number" ? opts.maxMissing : 1;

  ["ce", "pe"].forEach(function (side) {
    var s = audit[side];
    if (!s || !s.failed) return;
    if (s.failed.length === 0)         return; // all filters passed (was an entry)
    if (s.failed.length > maxMissing)  return; // too far from entry to be interesting

    var missedStrs = s.failed.map(function (f) { return f.name + " (" + f.detail + ")"; });
    log(
      "🎯 [" + tag + "] NEAR-MISS " + side.toUpperCase() +
      " " + s.passed + "/" + s.total +
      " — missed: " + missedStrs.join("; ")
    );
  });
}

module.exports = { logNearMiss: logNearMiss };

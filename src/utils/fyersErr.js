/**
 * Readable text for whatever the Fyers SDK threw.
 *
 * On an HTTP error the SDK rejects with the raw Fyers body — a PLAIN OBJECT
 * ({s, code, message, data}), not an Error. Reading only `.message` off it
 * reduces every parameter complaint to the bare word "Invalid input" and throws
 * away `data`, which is the one field that says WHICH parameter Fyers disliked
 * (e.g. {range_to: "Date range cannot exceed 366 days…"}). Keep the whole thing.
 *
 * Lived in gapFix3mBacktest.js until a BB_RSI 3-min backtest failed with nothing
 * on screen but "Invalid input" — the same swallowed detail, in a route that had
 * no copy of this. It is shared now so no caller has to rediscover it.
 */
function fyersErrText(err) {
  if (err && typeof err === "object" && !(err instanceof Error)) {
    const bits = [err.message || err.s || "error"];
    if (err.code != null) bits.push(`code ${err.code}`);
    if (err.data && typeof err.data === "object") {
      const detail = Object.entries(err.data).map(([k, v]) => `${k}: ${v}`).join("; ");
      if (detail) bits.push(detail);
    } else if (err.data) bits.push(String(err.data));
    return bits.join(" — ");
  }
  return String((err && err.message) || err);
}

module.exports = { fyersErrText };

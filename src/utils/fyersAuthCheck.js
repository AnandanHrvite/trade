/**
 * fyersAuthCheck.js — Pre-flight Fyers token validity check.
 * ─────────────────────────────────────────────────────────────────────────────
 * The mere presence of ACCESS_TOKEN in env is not proof that the token is
 * actually valid — it can be stale, partially-completed (mobile login dropped
 * the redirect), or revoked server-side. Hitting a cheap REST endpoint is the
 * only way to find out before we wire up the WebSocket and discover -15s.
 *
 * Use from /start route handlers as a hard precondition. If the token is bad,
 * we clear it from disk + env so the next /auth/login returns a clean state.
 *
 * Result is cached briefly (10s) so back-to-back start clicks across multiple
 * modes don't hammer the Fyers API.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const fyers = require("../config/fyers");

const CACHE_TTL_MS = 10_000;
let _cache = { at: 0, result: null };

/**
 * @returns {Promise<{ok: true} | {ok: false, code: string, message: string}>}
 *   code is one of: NO_TOKEN | INVALID_TOKEN | NETWORK_ERROR
 */
async function verifyFyersToken() {
  if (!process.env.ACCESS_TOKEN) {
    return { ok: false, code: "NO_TOKEN", message: "Fyers not logged in. Visit /auth/login to authenticate." };
  }

  // Serve cached "ok" if recent — avoids hammering the broker on rapid starts.
  // We never cache failures: a failure means the token is bad and we want any
  // re-login to take effect immediately.
  if (_cache.result && _cache.result.ok && (Date.now() - _cache.at) < CACHE_TTL_MS) {
    return _cache.result;
  }

  let resp;
  try {
    resp = await fyers.get_profile();
  } catch (err) {
    // Network error — don't clear the token, since the token might still be
    // valid and the user's network is the problem. Surface the error so the
    // user can see what's wrong, but don't pretend the auth is dead.
    return { ok: false, code: "NETWORK_ERROR", message: `Could not reach Fyers: ${err.message}` };
  }

  if (resp && resp.s === "ok") {
    _cache = { at: Date.now(), result: { ok: true } };
    return { ok: true };
  }

  // Anything other than s:"ok" means the broker rejected the token. Clear it
  // so subsequent reads see a clean "logged out" state. The user must re-login.
  const reason = (resp && (resp.message || resp.code)) || "Unknown auth error";
  try { fyers.clearFyersToken(); } catch (_) {}
  return { ok: false, code: "INVALID_TOKEN", message: `Fyers rejected token: ${reason}. Please re-login.` };
}

module.exports = { verifyFyersToken };

/**
 * brokerSafety.js — Live-trade safety primitives
 * ─────────────────────────────────────────────────────────────────────────────
 * Three building blocks shared by Fyers + Zerodha broker layers:
 *
 *   1. CircuitBreaker  — per-broker kill-switch. After N consecutive failures
 *                        the breaker OPENs and fails calls fast for openMs.
 *                        After openMs, one HALF_OPEN probe is allowed; if it
 *                        succeeds the breaker CLOSEs, else it re-OPENs.
 *
 *   2. withRetry       — idempotent retry (reads / status queries).
 *                        Retries on transient network errors with exp backoff.
 *
 *   3. withCautiousRetry — non-idempotent retry (writes / orders).
 *                        ONLY retries when the request clearly never reached
 *                        the broker (pre-flight network errors). If the broker
 *                        responded with a rejection, we return that rejection
 *                        and do NOT retry — preventing duplicate fills.
 *
 * Design notes
 * ─────────────
 *   • Order placement is NOT idempotent at Indian brokers. A retry after a
 *     timeout-mid-flight can double-fill. Therefore writes only retry when the
 *     underlying SDK call threw a network-level error (ETIMEDOUT/ECONNRESET/
 *     ENOTFOUND/etc.) BEFORE getting any response.
 *   • Reads (getOrders / getPositions / getFunds) are safe to retry liberally.
 *   • The breaker is shared across all calls for that broker so one outage
 *     short-circuits every code path (orders, SLs, queries) until recovery.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */

// Async, fire-and-forget Telegram. Circuit transitions happen while the process
// is alive (mid-session), so we must NOT use sendTelegramSync here — that spawns
// a blocking curl (up to ~5s) and would freeze the event loop (and every live SL
// check) exactly when the broker is flaky. sendTelegram never rejects.
let _telegram = null;
try { _telegram = require("./notify").sendTelegram; } catch (_) { _telegram = null; }

// ─────────────────────────────────────────────────────────────────────────────
// Runtime config — read from process.env on each access so Settings page
// edits take effect without a server restart.
// ─────────────────────────────────────────────────────────────────────────────

function _num(v, fallback, min = 1) {
  const n = Number(v);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

function safetyConfig() {
  return {
    cbFailThreshold:    _num(process.env.BROKER_CB_FAIL_THRESHOLD,     5, 1),
    cbOpenMs:           _num(process.env.BROKER_CB_OPEN_SEC,          30, 1) * 1000,
    retryReadAttempts:  _num(process.env.BROKER_RETRY_READ_ATTEMPTS,   3, 1),
    retryWriteAttempts: _num(process.env.BROKER_RETRY_WRITE_ATTEMPTS,  2, 1),
    retryBaseMs:        _num(process.env.BROKER_RETRY_BASE_MS,       150, 10),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Transient-error classifier
// ─────────────────────────────────────────────────────────────────────────────

const TRANSIENT_CODES = new Set([
  "ETIMEDOUT", "ESOCKETTIMEDOUT", "ECONNRESET", "ECONNREFUSED",
  "ENOTFOUND", "EAI_AGAIN", "EPIPE", "EHOSTUNREACH", "ENETUNREACH",
]);
const TRANSIENT_MSG = [
  "timeout", "socket hang up", "network", "econnreset", "etimedout",
  "getaddrinfo", "dns", "request failed", "503", "502", "504",
  "rate limit", "too many requests", "throttle",
];

function isTransientNetwork(err) {
  if (!err) return false;
  if (err.code && TRANSIENT_CODES.has(String(err.code).toUpperCase())) return true;
  const msg = (err.message || String(err)).toLowerCase();
  return TRANSIENT_MSG.some((needle) => msg.includes(needle));
}

// ── Connect-phase classifier (for NON-idempotent writes only) ─────────────────
// A write may only be retried if the request PROVABLY never reached the broker —
// i.e. the failure happened before any bytes were sent (DNS/connect refused).
// Errors like ETIMEDOUT / ECONNRESET / EPIPE / "socket hang up" / 502 / 503 /
// 504 / 429 can all occur AFTER the exchange accepted the order (the response
// was lost, not the request), so retrying them risks a DUPLICATE FILL. Those are
// deliberately EXCLUDED here even though isTransientNetwork() (reads) treats them
// as retryable.
const CONNECT_PHASE_CODES = new Set([
  "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH",
]);
function isConnectPhaseError(err) {
  if (!err) return false;
  const code = err.code && String(err.code).toUpperCase();
  if (code && CONNECT_PHASE_CODES.has(code)) return true;
  // DNS failures sometimes surface only in the message.
  const msg = (err.message || String(err)).toLowerCase();
  return msg.includes("getaddrinfo") || msg.includes("econnrefused")
      || msg.includes("dns");
}

// ─────────────────────────────────────────────────────────────────────────────
// CircuitBreaker
// ─────────────────────────────────────────────────────────────────────────────

const STATE = { CLOSED: "CLOSED", OPEN: "OPEN", HALF_OPEN: "HALF_OPEN" };

class CircuitBreaker {
  constructor(name, opts = {}) {
    this.name              = name;
    this._optFail          = opts.failureThreshold; // optional override (testing)
    this._optOpenMs        = opts.openMs;           // optional override (testing)
    this.halfOpenMaxCalls  = opts.halfOpenMaxCalls || 1;

    this.state            = STATE.CLOSED;
    this.failures         = 0;
    this.openedAt         = 0;
    this.halfOpenInFlight = 0;
    this._notified        = false; // dedupe telegram per open-cycle
  }

  // Read thresholds live from env so Settings changes take effect immediately.
  get failureThreshold() { return this._optFail   != null ? this._optFail   : safetyConfig().cbFailThreshold; }
  get openMs()           { return this._optOpenMs != null ? this._optOpenMs : safetyConfig().cbOpenMs; }

  /** Returns true if call may pass; decrements half-open budget if so. */
  canPass() {
    if (this.state === STATE.CLOSED) return true;
    if (this.state === STATE.OPEN) {
      if (Date.now() - this.openedAt >= this.openMs) {
        this.state            = STATE.HALF_OPEN;
        this.halfOpenInFlight = 0;
        console.warn(`[CircuitBreaker:${this.name}] HALF_OPEN — allowing probe`);
      } else {
        return false;
      }
    }
    if (this.halfOpenInFlight < this.halfOpenMaxCalls) {
      this.halfOpenInFlight++;
      return true;
    }
    return false;
  }

  onSuccess() {
    if (this.state === STATE.HALF_OPEN) {
      console.warn(`[CircuitBreaker:${this.name}] CLOSED — recovery confirmed`);
      try { _telegram && _telegram(`✅ Broker ${this.name.toUpperCase()} recovered (circuit closed)`); } catch (_) {}
    }
    this.state            = STATE.CLOSED;
    this.failures         = 0;
    this.halfOpenInFlight = 0;
    this._notified        = false;
  }

  onFailure(err) {
    this.failures++;
    if (this.state === STATE.HALF_OPEN) { this._trip(err); return; }
    if (this.failures >= this.failureThreshold) this._trip(err);
  }

  _trip(err) {
    this.state            = STATE.OPEN;
    this.openedAt         = Date.now();
    this.halfOpenInFlight = 0;
    const reason = (err && err.message) ? err.message : "consecutive failures";
    console.error(`[CircuitBreaker:${this.name}] OPEN for ${this.openMs}ms after ${this.failures} failure(s) — last: ${reason}`);
    if (!this._notified) {
      this._notified = true;
      try { _telegram && _telegram(`🚨 Broker ${this.name.toUpperCase()} circuit OPEN\nfailures=${this.failures} pauseMs=${this.openMs}\nlast: ${String(reason).slice(0, 180)}`); } catch (_) {}
    }
  }

  status() {
    return {
      name:            this.name,
      state:           this.state,
      failures:        this.failures,
      msUntilHalfOpen: this.state === STATE.OPEN
        ? Math.max(0, this.openMs - (Date.now() - this.openedAt))
        : 0,
    };
  }
}

// One breaker per broker; shared across all order/query paths. Thresholds are
// pulled live from process.env via safetyConfig() — see CircuitBreaker getters.
const breakers = {
  fyers:   new CircuitBreaker("fyers"),
  zerodha: new CircuitBreaker("zerodha"),
};

class CircuitOpenError extends Error {
  constructor(name, msUntil) {
    super(`Circuit OPEN for ${name} — retry in ${Math.ceil(msUntil / 1000)}s`);
    this.code = "CIRCUIT_OPEN";
    this.broker = name;
    this.msUntilHalfOpen = msUntil;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Retry wrappers
// ─────────────────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * withRetry — for IDEMPOTENT operations (reads, status queries).
 * Retries on any thrown error that looks transient. Default: 3 attempts.
 */
async function withRetry(fn, { attempts = 3, baseMs = 120, label = "op" } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); }
    catch (err) {
      lastErr = err;
      if (i === attempts - 1) break;
      if (!isTransientNetwork(err)) throw err;
      const delay = baseMs * Math.pow(2, i) + Math.floor(Math.random() * 60);
      console.warn(`[Retry:${label}] attempt ${i + 1}/${attempts} failed (${err.message}); retry in ${delay}ms`);
      await sleep(delay);
    }
  }
  throw lastErr;
}

/**
 * withCautiousRetry — for NON-IDEMPOTENT writes (orders, SLs, modify, cancel).
 * Only retries when the inner fn THROWS a transient network error — meaning
 * the request never reached the broker. If the broker responded (even with
 * a rejection), we return that response and do NOT retry, so we never
 * double-place an order that may already be live.
 */
async function withCautiousRetry(fn, { attempts = 2, baseMs = 200, label = "write" } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); }
    catch (err) {
      lastErr = err;
      if (i === attempts - 1) throw err;
      // ONLY retry when the request provably never reached the broker. A
      // response-phase transient (ETIMEDOUT/ECONNRESET/5xx/429) may mean the
      // order is already live — retrying it would double-fill, so we surface it.
      if (!isConnectPhaseError(err)) throw err;
      const delay = baseMs * (i + 1);
      console.warn(`[CautiousRetry:${label}] pre-flight connect error (${err.message}); retry ${i + 1}/${attempts - 1} in ${delay}ms`);
      await sleep(delay);
    }
  }
  throw lastErr;
}

// ─────────────────────────────────────────────────────────────────────────────
// guardedCall — circuit-breaker gate + success/failure bookkeeping
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Runs `fn()` only if the named breaker is closed (or in half-open probe).
 * On success → breaker closes. On thrown error → breaker counts a failure.
 *
 * IMPORTANT — what counts as a "failure" for the breaker:
 *   • A thrown error: yes (network failure, exception, etc.)
 *   • A returned {success:false} from a broker write: NO. Broker-level
 *     rejection (validation, margin, etc.) is not an infra failure, so we
 *     don't want it to trip the breaker. The broker layer translates SDK
 *     exceptions into {success:false} for its callers; the inner functions
 *     used with guardedCall throw on real errors and return on rejections.
 */
async function guardedCall(brokerName, fn) {
  const cb = breakers[brokerName];
  if (cb && !cb.canPass()) {
    const s = cb.status();
    throw new CircuitOpenError(brokerName, s.msUntilHalfOpen);
  }
  try {
    const result = await fn();
    if (cb) cb.onSuccess();
    return result;
  } catch (err) {
    if (cb) cb.onFailure(err);
    throw err;
  }
}

/** Snapshot of every breaker — for /health or admin endpoints. */
function breakerStatus() {
  return Object.fromEntries(Object.entries(breakers).map(([k, v]) => [k, v.status()]));
}

module.exports = {
  CircuitBreaker,
  CircuitOpenError,
  breakers,
  breakerStatus,
  guardedCall,
  withRetry,
  withCautiousRetry,
  isTransientNetwork,
  isConnectPhaseError,
  safetyConfig,
};

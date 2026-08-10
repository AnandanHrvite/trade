/**
 * asyncRouteErrors.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Make Express 4 forward a REJECTED async handler to the error middleware.
 *
 * ── The problem ─────────────────────────────────────────────────────────────
 * Express 4's Layer.handle_request calls the handler inside a try/catch, which
 * catches a SYNCHRONOUS throw and hands it to next(err). An `async` handler
 * never throws synchronously — it returns a promise — so a rejection escapes
 * the try entirely. Express then does nothing: `next` is never called, no
 * response is ever written, and the request hangs until the browser or the
 * proxy times out. The rejection surfaces instead on the process-level
 * `unhandledRejection` handler in app.js, which fires a Telegram alert.
 *
 * This repo has ~100 `async (req, res)` handlers — every /status, /start,
 * /stop and backtest endpoint. Any one of them awaiting a broker call during a
 * Fyers/Zerodha hiccup produced: a spinning page, no error shown, and a
 * "🚨 UNHANDLED REJECTION" telegram. Confirmed against express 4.22.1:
 *
 *     app.get("/boom", async (req, res) => { throw new Error("x"); });
 *     → UNHANDLED REJECTION, request never answered
 *
 * ── The fix ─────────────────────────────────────────────────────────────────
 * Patch Layer.prototype.handle_request once, at boot, so a returned
 * promise-like has its rejection routed to next(err). Every route registered
 * anywhere — app.js, every router under routes/ — then reaches the central
 * error handler in app.js, which answers 500 (HTML or JSON) and logs. Handlers
 * keep their own try/catch where they have one; this only catches what would
 * otherwise be lost.
 *
 * Patching the Layer is deliberate: the alternative is wrapping ~100 call
 * sites by hand, which silently fails for the next handler someone adds.
 * Route files stay plain Express with no wrapper to remember.
 *
 * MUST be required before the route modules are required in app.js.
 * Idempotent; never throws (a failure to patch degrades to today's behaviour
 * rather than blocking boot).
 */

const PATCHED = Symbol.for("trade.asyncRouteErrors.patched");

/** True when `v` is thenable (a native promise or any promise-like). */
function isThenable(v) {
  return !!v && (typeof v === "object" || typeof v === "function") && typeof v.then === "function";
}

/**
 * A rejection with no Error in it (e.g. `Promise.reject()` or a rejected
 * string) would reach the error handler as undefined and be reported as a
 * blank 500. Normalise so the log and the response always carry a message.
 */
function toError(reason) {
  if (reason instanceof Error) return reason;
  const err = new Error(
    reason === undefined || reason === null
      ? "Async route handler rejected with no error"
      : String(reason),
  );
  err.original = reason;
  return err;
}

function install() {
  let Layer;
  try {
    Layer = require("express/lib/router/layer");
  } catch (e) {
    console.warn(`[asyncRouteErrors] express internals not found — async route rejections stay unhandled: ${e.message}`);
    return false;
  }

  if (!Layer || !Layer.prototype || typeof Layer.prototype.handle_request !== "function") {
    console.warn("[asyncRouteErrors] unexpected express Layer shape — skipping patch");
    return false;
  }
  if (Layer.prototype[PATCHED]) return true;   // idempotent across re-requires

  const originalRequest = Layer.prototype.handle_request;
  const originalError   = Layer.prototype.handle_error;

  Layer.prototype.handle_request = function handle(req, res, next) {
    const fn = this.handle;
    // Mirror express's own guard: >3 args means this layer is an error handler,
    // not a request handler. Delegate so the semantics stay identical.
    if (typeof fn !== "function" || fn.length > 3) return originalRequest.call(this, req, res, next);

    // A handler may hand control on with next() and only then reject — a
    // fire-and-forget await after passing the request along. Injecting that
    // error would hijack a request another layer has already taken over (and may
    // already have answered), so once next() has run the rejection is logged and
    // the chain is left alone. Tracked rather than assumed: `res.headersSent` is
    // not the same question, and is still handled downstream.
    let passedOn = false;
    const onward = function (...args) { passedOn = true; return next.apply(this, args); };

    let ret;
    try {
      // Called bare, exactly as express does — NOT fn.call(this, …). A layer
      // handler written as `function (req, res)` sees the same `this` it always
      // did; binding it to the Layer here would be a silent behaviour change.
      ret = fn(req, res, onward);
    } catch (err) {
      return next(err);                        // synchronous throw — express's own path
    }
    if (isThenable(ret)) {
      ret.then(undefined, (reason) => {
        const err = toError(reason);
        if (passedOn) {
          console.error(`[asyncRouteErrors] late rejection after next() on ${req.method} ${req.originalUrl || req.url}: ${err.message}`);
          return;
        }
        next(err);
      });
    }
    return ret;
  };

  if (typeof originalError === "function") {
    Layer.prototype.handle_error = function handleError(error, req, res, next) {
      const fn = this.handle;
      if (typeof fn !== "function" || fn.length !== 4) return originalError.call(this, error, req, res, next);
      let ret;
      try {
        ret = fn(error, req, res, next);        // bare call, as express does
      } catch (err) {
        return next(err);
      }
      // An async error-handling middleware that rejects would otherwise abandon
      // the request in exactly the same way the request path did.
      if (isThenable(ret)) ret.then(undefined, (reason) => next(toError(reason)));
      return ret;
    };
  }

  Layer.prototype[PATCHED] = true;
  return true;
}

module.exports = { install, isThenable, toError };

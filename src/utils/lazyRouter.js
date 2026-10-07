/**
 * lazyRouter.js — mount a router whose module is only require()d on first request.
 *
 *   app.use("/x-backtest", lazyRouter(() => require("./routes/xBacktest")));
 *
 * The loader is a thunk so the require() stays relative to the caller and the
 * mount line still names the module (tests grep app.js for it). Until a request
 * arrives the module's source is never compiled, so a page nobody opens — a
 * disabled strategy's backtest, say — costs no heap. A Settings toggle flipped ON
 * at runtime needs no restart: the next request loads the module.
 *
 * Only for PURE routers: no boot-time side effects and no other boot importer.
 * A lazy mount exposes no `.stack`, so it is invisible to router-stack walkers
 * (utils/startAllRoster.js looks for `/start`, utils/paperReset.js for `/reset`) —
 * never use it for a -paper / -live / -live-harness mount.
 */
function lazyRouter(load) {
  let router = null;
  return function lazyMountedRouter(req, res, next) {
    if (!router) {
      try {
        router = load();
      } catch (err) {
        // Not cached: a transient failure retries on the next request.
        console.error(`❌ [LAZY-ROUTER] ${req.baseUrl || "?"} failed to load: ${err.message}`);
        return next(err);
      }
    }
    return router(req, res, next);
  };
}

module.exports = { lazyRouter };

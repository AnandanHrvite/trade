/**
 * startAllRoster.js — the dashboard's Start-All roster, DISCOVERED not declared.
 * ─────────────────────────────────────────────────────────────────────────────
 * The three Start All buttons (Paper / Live / Live-Harness) used to read a
 * hand-written route table in app.js, so a new strategy silently sat out of them
 * until someone remembered to add a row. This module removes that step: it
 * records every `app.use(path, router)` mount, keeps the ones that actually
 * expose a `/start` route, and joins them to the enabled strategies from
 * sharedNav's STRATEGY_MODES. Mount a new strategy's routes the way every other
 * strategy is mounted and it takes part in Start All with no further wiring.
 *
 * Route-shape contract (already true of all 12 strategies):
 *   /{slug}-paper/start           canonical paper engine
 *   /{slug}-live/start            live route — a real-order engine, OR the
 *                                 paper-wrapping harness for the eight
 *                                 strategies that have no separate live engine
 *   /{slug}-live-harness/start    paper-wrapping harness, when the strategy
 *                                 also has a real-order live engine
 * Which of the two a `-live` mount is, is DECLARED, not guessed: every harness
 * router sets `router.isLiveHarness = true`. Guessing it from the path would
 * mean the day someone mounts a real-order live engine at /{slug}-live with no
 * harness beside it, the 🧪 Start All (Harness) button fires real orders. An
 * unmarked `-live` mount is therefore treated as a real live engine — it joins
 * Start All (Live) and is left out of Start All (Harness).
 *
 * The mode key is matched to the route slug case- and separator-insensitively
 * (EMA_RSI_ST ↔ /ema_rsi_st-…, BN_PIVOT_RSI_ST ↔ /bn-pivot-rsi-st-…). A
 * strategy whose key is not its slug declares `slug` on its STRATEGY_MODES row.
 */

const { enabledStrategies } = require('./sharedNav');

// Every string-path mount, in mount order. Populated by trackMounts().
const _mounts = [];

/**
 * Wrap app.use so each `app.use('/path', handler)` is recorded. Must run before
 * the route block in app.js; mounts made before it are simply not seen (none of
 * them are strategy routes).
 */
function trackMounts(app) {
  if (app.__startAllMountsTracked) return app;
  const original = app.use.bind(app);
  app.use = function (...args) {
    if (typeof args[0] === 'string' && args.length > 1) {
      for (const h of args.slice(1)) _mounts.push({ path: args[0], handler: h });
    }
    return original(...args);
  };
  app.__startAllMountsTracked = true;
  return app;
}

// True for an Express Router that registers a `/start` route (any method).
function hasStartRoute(handler) {
  const stack = handler && handler.stack;
  if (!Array.isArray(stack)) return false;
  return stack.some((l) => l && l.route && l.route.path === '/start');
}

// True when the router registers `path` itself (any method).
function hasRoute(handler, path) {
  const stack = handler && handler.stack;
  if (!Array.isArray(stack)) return false;
  return stack.some((l) => l && l.route && l.route.path === path);
}

/**
 * The URL a human should land on for this router. The paper/backtest routers
 * render their page at `/status` and keep the mount root unrouted (a 404), while
 * the live-harness routers render at `/`. Probing the router instead of assuming
 * either shape is what keeps a tile link off a dead URL.
 * Falls back to the mount path when neither exists — no route to guess at.
 */
function pageUrl(mountPath, handler) {
  if (hasRoute(handler, '/')) return mountPath;
  if (hasRoute(handler, '/status')) return `${mountPath}/status`;
  return mountPath;
}

// Longest suffix first — '/bb_rsi-live-harness' also ends in '-live'.
const SUFFIXES = [['-live-harness', 'harness'], ['-live', 'live'], ['-paper', 'paper']];

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// slug → { paper, live, harness } mount paths, for every startable router.
function discoverStartRoutes() {
  const bySlug = new Map();
  for (const m of _mounts) {
    if (!hasStartRoute(m.handler)) continue;
    for (const [suffix, slot] of SUFFIXES) {
      if (!m.path.endsWith(suffix)) continue;
      // A `-live` mount goes in the harness slot only when the router says so.
      const kind = (slot === 'live' && m.handler.isLiveHarness) ? 'harness' : slot;
      const key = norm(m.path.slice(0, m.path.length - suffix.length));
      if (!key) break;
      const entry = bySlug.get(key)
        || { paper: null, live: null, harness: null, pages: {} };
      if (!entry[kind]) {
        entry[kind] = m.path;                      // first mount wins
        entry.pages[kind] = pageUrl(m.path, m.handler);
      }
      bySlug.set(key, entry);
      break;
    }
  }
  return bySlug;
}

const _warned = new Set();

/**
 * The strategies enabled in Settings, joined to their start routes.
 * Read per request — Settings saves mutate process.env live, and the dashboard
 * refetches this on every Start-All click.
 *
 * @returns {Array<{mode,label,paper,live,harness}>} `paper` is always present;
 *          `live` is null for a strategy with no real-order live engine, and
 *          `harness` is null for one with no declared harness.
 */
function startAllRoster() {
  const found = discoverStartRoutes();
  const roster = [];
  for (const s of enabledStrategies()) {
    const routes = found.get(norm(s.slug || s.mode));
    if (!routes || !routes.paper) {
      if (!_warned.has(s.mode)) {
        _warned.add(s.mode);
        console.warn(`⚠️  [START-ALL] ${s.mode} has no "-paper/start" route mounted — left out of Start All.`);
      }
      continue;
    }
    roster.push({
      mode:    s.mode,
      label:   s.label,
      paper:   `${routes.paper}/start`,
      live:    routes.live    ? `${routes.live}/start`    : null,
      harness: routes.harness ? `${routes.harness}/start` : null,
    });
  }
  return roster;
}

module.exports = { trackMounts, discoverStartRoutes, startAllRoster };

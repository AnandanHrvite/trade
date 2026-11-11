/**
 * startAllRoster.js — the dashboard's Start-All roster, DISCOVERED not declared.
 * ─────────────────────────────────────────────────────────────────────────────
 * The Start All (Paper) button used to read a
 * hand-written route table in app.js, so a new strategy silently sat out of it
 * until someone remembered to add a row. This module removes that step: it
 * records every `app.use(path, router)` mount, keeps the ones that actually
 * expose a `/start` route, and joins them to the enabled strategies from
 * sharedNav's STRATEGY_MODES. Mount a new strategy's routes the way every other
 * strategy is mounted and it takes part in Start All with no further wiring.
 *
 * Route-shape contract (true of every strategy):
 *   /{slug}-paper/start           canonical paper engine
 *
 * The mode key is matched to the route slug case- and separator-insensitively
 * (EMA_RSI_ST ↔ /ema_rsi_st-…, RSI_PIVOT_ST ↔ /rsi-pivot-st-…). A
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
 * render their page at `/status` and keep the mount root unrouted (a 404).
 * Probing the router instead of assuming the shape is what keeps a tile link
 * off a dead URL.
 * Falls back to the mount path when neither exists — no route to guess at.
 */
function pageUrl(mountPath, handler) {
  if (hasRoute(handler, '/')) return mountPath;
  if (hasRoute(handler, '/status')) return `${mountPath}/status`;
  return mountPath;
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// slug → { paper } mount path, for every startable paper router.
function discoverStartRoutes() {
  const bySlug = new Map();
  for (const m of _mounts) {
    if (!hasStartRoute(m.handler)) continue;
    if (!m.path.endsWith('-paper')) continue;
    const key = norm(m.path.slice(0, m.path.length - '-paper'.length));
    if (!key) continue;
    const entry = bySlug.get(key) || { paper: null, pages: {} };
    if (!entry.paper) {
      entry.paper = m.path;                        // first mount wins
      entry.pages.paper = pageUrl(m.path, m.handler);
    }
    bySlug.set(key, entry);
  }
  return bySlug;
}

const _warned = new Set();

// Some paper routes have their own `{MODE}_PAPER_ENABLED` gate on /start; a row
// whose gate ships off declares `paperDefault: 'false'`. No key = always on.
function paperEnabled(s) {
  return String(process.env[`${s.mode}_PAPER_ENABLED`] || s.paperDefault || 'true').toLowerCase() === 'true';
}

/**
 * The strategies enabled in Settings, joined to their start routes.
 * Read per request — Settings saves mutate process.env live, and the dashboard
 * refetches this on every Start-All click.
 *
 * @returns {Array<{mode,label,paper,paperOff}>} `paper` is always present
 *          (`paperOff` true when its paper toggle would refuse the start).
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
      // Paper Start All skips it: its /start would only refuse with 403.
      paperOff: !paperEnabled(s),
    });
  }
  // Running (strategy, market) pairs switched ON (config/pairs.js runnable),
  // each at its own /<modeKey>-paper. Paper switch: the pair's own value, else
  // its strategy's NIFTY value (pairRuntime.paperEnabled).
  const pairs = require('../config/pairs');
  const pairRuntime = require('./pairRuntime');
  for (const p of pairs.runnable({ enabledOnly: true })) {
    const routes = found.get(norm(p.modeKey));
    if (!routes || !routes.paper) continue;
    const rt = pairRuntime.forPair(p);
    roster.push({ mode: p.envPrefix, label: rt.title, paper: `${routes.paper}/start`, paperOff: !rt.paperEnabled() });
  }
  return roster;
}

module.exports = { trackMounts, discoverStartRoutes, startAllRoster };

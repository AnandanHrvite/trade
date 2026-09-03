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
 *   /{slug}-live/start            pure-live engine, when the strategy has one
 *   /{slug}-live-harness/start    paper-wrapping harness, when the strategy
 *                                 has a separate live engine
 * A strategy with only a `-live` mount is one whose live route IS the
 * paper-wrapping harness (EMA9+VWAP, Trend_PB, TDS, HA Scalp, SIMPLE_9:30,
 * RSI Pivot ST, BN Pivot RSI ST, EarlyBird) — it takes part in Paper + Harness
 * and is left out of Start All (Live), exactly as the old table said.
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

// Longest suffix first — '/bb_rsi-live-harness' also ends in '-live'.
const KINDS = [['-live-harness', 'harness'], ['-live', 'live'], ['-paper', 'paper']];

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// slug → { paper, live, harness } mount paths, for every startable router.
function discoverStartRoutes() {
  const bySlug = new Map();
  for (const m of _mounts) {
    if (!hasStartRoute(m.handler)) continue;
    for (const [suffix, kind] of KINDS) {
      if (!m.path.endsWith(suffix)) continue;
      const key = norm(m.path.slice(0, m.path.length - suffix.length));
      if (!key) break;
      const entry = bySlug.get(key) || { paper: null, live: null, harness: null };
      if (!entry[kind]) entry[kind] = m.path;   // first mount wins
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
 * @returns {Array<{mode,label,paper,live,harness}>} `live` is null for a
 *          harness-only strategy; `paper`/`harness` are always present.
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
    // No separate -live-harness mount ⇒ the -live route is the harness.
    const live    = routes.harness ? routes.live : null;
    const harness = routes.harness || routes.live;
    roster.push({
      mode:    s.mode,
      label:   s.label,
      paper:   `${routes.paper}/start`,
      live:    live    ? `${live}/start`    : null,
      harness: harness ? `${harness}/start` : null,
    });
  }
  return roster;
}

module.exports = { trackMounts, discoverStartRoutes, startAllRoster };

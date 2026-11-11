/**
 * scopedEnv.js — run one async job with its OWN view of a few env keys
 * ─────────────────────────────────────────────────────────────────────────────
 * The /backtest page runs a strategy's existing backtest engine with settings
 * that are not the live ones — the "custom" settings a user typed, or another
 * market's pair keys (pairs.js: own → NIFTY → default) mapped onto the home
 * keys the engine reads. The engines read process.env live, and the same
 * process is running paper sessions, so writing those values into process.env
 * would silently retune every running paper engine for the length of the run.
 *
 * run(overrides, fn) instead gives `fn` — and every callback, timer and promise
 * continuation created inside it (AsyncLocalStorage) — an env where each key in
 * `overrides` reads as its override value (null = unset). Everything else in the
 * process (tick handlers, Settings saves, the HTTP server) keeps reading the
 * real env, because none of it runs inside that async context.
 *
 * process.env is replaced by a read-through Proxy the FIRST time run() is used
 * (never at require time, so a process that never runs a custom backtest keeps
 * the plain env object). Outside a scoped run every trap forwards to the real
 * env, so reads, writes, `in`, Object.keys and {...process.env} are unchanged.
 * Writes always go to the real env — a scoped run cannot persist a value.
 *
 * Limits: a module that copied a value at require time (a top-level constant)
 * does not see an override; the scope is only as wide as the async chain, so
 * work handed to a pre-existing queue that was started elsewhere runs unscoped.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const { AsyncLocalStorage } = require("async_hooks");

const _als = new AsyncLocalStorage();
const _has = Object.prototype.hasOwnProperty;
let _real = null;

function _install() {
  if (_real) return;
  _real = process.env;
  const real = _real;
  const over = (k) => {
    const o = _als.getStore();
    return o && typeof k === "string" && _has.call(o, k) ? o : null;
  };
  process.env = new Proxy(real, {
    // Writes and deletes always hit the real env (its string coercion included).
    set(t, k, v) { t[k] = v; return true; },
    deleteProperty(t, k) { delete t[k]; return true; },
    get(t, k) {
      const o = over(k);
      if (!o) return t[k];
      return o[k] === null ? undefined : o[k];
    },
    has(t, k) {
      const o = over(k);
      return o ? o[k] !== null : k in t;
    },
    ownKeys(t) {
      const o = _als.getStore();
      const keys = Reflect.ownKeys(t);
      if (!o) return keys;
      const out = keys.filter((k) => !(typeof k === "string" && _has.call(o, k) && o[k] === null));
      for (const k of Object.keys(o)) if (o[k] !== null && !_has.call(t, k)) out.push(k);
      return out;
    },
    getOwnPropertyDescriptor(t, k) {
      const o = over(k);
      if (!o) return Reflect.getOwnPropertyDescriptor(t, k);
      if (o[k] === null) return undefined;
      return { value: o[k], writable: true, enumerable: true, configurable: true };
    },
  });
}

/** Normalise an overrides map: string values, null for "unset". */
function _clean(overrides) {
  const out = {};
  for (const k of Object.keys(overrides || {})) {
    const v = overrides[k];
    out[k] = v === undefined || v === null ? null : String(v);
  }
  return Object.freeze(out);
}

/**
 * Run `fn` with `overrides` visible through process.env. Returns fn's result
 * (a promise when fn is async). An empty map runs fn directly — no proxy, no
 * scope — so a "current settings" run is exactly the unscoped code path.
 */
function run(overrides, fn) {
  const o = _clean(overrides);
  if (!Object.keys(o).length) return fn();
  _install();
  const outer = _als.getStore();
  return _als.run(outer ? Object.freeze(Object.assign({}, outer, o)) : o, fn);
}

/** The overrides active in the current async context, or null. */
function current() { return _als.getStore() || null; }

module.exports = { run, current };

/**
 * backtestPage.js — the dispatcher behind the ONE /backtest page
 * ─────────────────────────────────────────────────────────────────────────────
 * The page picks a strategy (strategyRegistry, those with a `backtest` entry), a
 * market (markets.js, those pairs.js offers for that strategy), a date range,
 * a candle size where the strategy allows one, and "current" or "custom"
 * settings. It runs nothing itself: every run goes through the strategy's OWN
 * backtest module — the same function its old per-strategy page calls — via
 * that module's `backtestPage` hook:
 *
 *   module.exports.backtestPage = {
 *     markets:    ["NIFTY", …],   markets this engine can run; every other
 *                                  offered market shows "coming soon"
 *     resolution: null | { options: ["3","5","15"], default: () => "5" }
 *     run:  async (jobId, { from, to, resolution?, market }) => void
 *           — the old page's job body: progress, fetch, simulate, its own
 *             saveResult, then backtestJobs.completeJob / failJob on jobId
 *     view: (jobResult, { from, to, market, jobId }) => renderBacktestResults() options
 *   };
 *
 * ENABLING ANOTHER MARKET for a strategy is a change in its backtest module
 * only: make `run` read the market (backtestMarket.context(market) gives the
 * spot symbol, lot, exchange and futures flag), then add the key to `markets`.
 * Its pair settings arrive for free — see SETTINGS below.
 *
 * SETTINGS. Every editable field is GENERATED from the Settings schema: the
 * strategy's own keys for that market (routes/settings.js pairFieldsFor — the
 * same list the Settings page shows), minus paper/live-only switches. A run
 * with the CURRENT settings of the strategy's home market (NIFTY) overrides
 * nothing — it is exactly the old page's code path. Another market, or custom
 * values, are applied to the run only, by mapping each pair key's value
 * (pairs.resolve: own → NIFTY's → default) or the typed value onto the home key
 * the engine reads, through utils/scopedEnv.js — the running paper engines in
 * this process never see them.
 *
 * One job at a time (backtestJobManager), progress + cancel through the shared
 * progress page, and every finished run is saved (resultStore.saveRun) with its
 * strategy, market and the exact settings it used, so it can be re-opened.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const registry     = require("../config/strategyRegistry");
const markets      = require("../config/markets");
const pairs        = require("../config/pairs");
const backtestJobs = require("../utils/backtestJobManager");
const scopedEnv    = require("../utils/scopedEnv");
const resultStore  = require("../utils/resultStore");

const _has = Object.prototype.hasOwnProperty;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Paper/live/UI switches are not backtest inputs.
const NOT_BACKTEST = /(_MODE_ENABLED|_PAPER_ENABLED|_LIVE_ENABLED|_POS_FILE|_DEBUG\w*|_TRACE\w*|_TELEGRAM\w*)$|_LIVE_|^TG_/;

function _settingsRouter() { return require("../routes/settings"); }

/** The hook of one strategy's backtest module, or null. */
function hookOf(strategyId) {
  const s = registry.byId(strategyId);
  if (!s || s.kind !== "strategy" || !s.backtest) return null;
  const mod = require(registry.srcPath(s.backtest.module));
  const h = mod && mod.backtestPage;
  return h && typeof h.run === "function" && typeof h.view === "function" ? h : null;
}

/** Every strategy that has a backtest, in sidebar order. */
function strategies() {
  return registry.strategies()
    .filter((s) => s.backtest)
    .slice()
    .sort((a, b) => a.nav.order - b.nav.order)
    .map((s) => ({ id: s.id, label: s.label, key: s.key, modeKey: s.modeKey, oldPage: s.backtest.path, ready: !!hookOf(s.id) }));
}

/**
 * The markets offered for a strategy (pairs.js), in markets.js order:
 *   [{ key, label, group, enabled, note }]   enabled = its engine runs there.
 */
function marketOptions(strategyId) {
  const h = hookOf(strategyId);
  const runs = new Set(h && Array.isArray(h.markets) ? h.markets : []);
  return markets.list()
    .filter((M) => pairs.isOffered(strategyId, M.key))
    .map((M) => ({
      key: M.key, label: M.label, group: M.group,
      enabled: runs.has(M.key),
      note: runs.has(M.key) ? null : "coming soon",
    }));
}

/** { options: [...], default } when the strategy lets you pick, else null (fixed). */
function resolutionOptions(strategyId) {
  const h = hookOf(strategyId);
  if (!h || !h.resolution || !Array.isArray(h.resolution.options)) return null;
  const def = typeof h.resolution.default === "function" ? String(h.resolution.default()) : String(h.resolution.options[0]);
  return { options: h.resolution.options.map(String), default: def };
}

/**
 * The strategy's backtest-relevant settings on one market, from the Settings
 * schema, with the value a run with "current settings" would use:
 *   [{ key, homeKey, label, type, options, min, max, step, group, desc,
 *      value, source: "own" | "inherited" | "default" }]
 * key is the pair's key (SENSEX_EMA_RSI_ST_V2_…); homeKey the key the engine
 * reads (EMA_RSI_ST_V2_…). On the home market they are the same.
 */
function settingsFields(strategyId, marketKey, env = process.env) {
  const pair = pairs.get(strategyId, marketKey);
  if (!pair) return [];
  const { fields } = _settingsRouter().pairSettings.pairFieldsFor(pair);
  const out = [];
  for (const f of fields) {
    const homeKey = f.homeKey || f.key;
    if (NOT_BACKTEST.test(homeKey) || f.type === "password") continue;
    const r = pairs.resolve(pair, homeKey, env, f.default);
    const source = pair.home
      ? (r.own ? "own" : "default")
      : (r.own ? "own" : (r.homeValue !== undefined ? "inherited" : "default"));
    out.push({
      key: f.key, homeKey, label: f.label || f.key, type: f.type || "text",
      options: Array.isArray(f.options) ? f.options.map((o) => (o && typeof o === "object" ? { value: String(o.value), label: String(o.label) } : { value: String(o), label: String(o) })) : null,
      min: f.min, max: f.max, step: f.step,
      group: f.group || "Entry", desc: f.desc || "",
      value: r.value === undefined || r.value === null ? "" : String(r.value),
      source,
    });
  }
  return out;
}

/**
 * The env the engine sees for this run, as overrides of its HOME keys, plus
 * the record of every setting:
 *   { overrides: { homeKey: value },
 *     settings: [{ key, homeKey, label, value, source, engineValue }] }
 * engineValue is what the engine actually reads for the run (null = unset, so
 * the engine's own code default applies — which can differ from the schema
 * default shown as `value`).
 * `custom` maps pair keys to typed values; a value equal to the current one is
 * not custom. Defaults are never written (an unset key keeps the engine's own
 * fallback, exactly as paper reads it).
 */
function buildOverrides(strategyId, marketKey, custom, env = process.env) {
  const pair = pairs.get(strategyId, marketKey);
  const fields = settingsFields(strategyId, marketKey, env);
  const overrides = {};
  const settings = [];
  for (const f of fields) {
    let value = f.value, source = f.source;
    if (custom && _has.call(custom, f.key)) {
      const v = String(custom[f.key] == null ? "" : custom[f.key]).trim();
      if (v !== f.value) { value = v; source = "custom"; }
    }
    const engineSees = env[f.homeKey] !== undefined && env[f.homeKey] !== "" ? String(env[f.homeKey]) : undefined;
    if (source === "custom") {
      if (value === "" ? engineSees !== undefined : value !== engineSees) overrides[f.homeKey] = value === "" ? null : value;
    } else if (pair && !pair.home && source === "own" && value !== engineSees) {
      overrides[f.homeKey] = value;
    }
    const ev = _has.call(overrides, f.homeKey) ? overrides[f.homeKey] : engineSees;
    settings.push({ key: f.key, homeKey: f.homeKey, label: f.label, value, source, engineValue: ev === undefined ? null : ev });
  }
  return { overrides, settings };
}

// ── Runs ─────────────────────────────────────────────────────────────────────

// jobId → { record, finished, error } for runs started from the page.
const _runs = new Map();

function _validate(q) {
  const s = registry.byId(q.strategy);
  if (!s || s.kind !== "strategy" || !s.backtest) return `Unknown strategy "${q.strategy}".`;
  const h = hookOf(s.id);
  if (!h) return `${s.label}'s backtest is not on this page yet — use its own page (${s.backtest.path}).`;
  const mk = String(q.market || "").toUpperCase();
  if (!pairs.isOffered(s.id, mk)) return `${s.label} is not offered on ${q.market || "(no market)"}.`;
  if (!(h.markets || []).includes(mk)) return `${s.label} on ${markets.get(mk).label} is coming soon — its backtest runs on ${(h.markets || []).join(", ")} today.`;
  if (!DATE_RE.test(q.from || "") || !DATE_RE.test(q.to || "")) return "Pick a From and a To date (YYYY-MM-DD).";
  if (q.from > q.to) return "From must be on or before To.";
  const ro = resolutionOptions(s.id);
  if (ro && q.resolution && !ro.options.includes(String(q.resolution))) return `Candle size ${q.resolution} is not one ${s.label} supports (${ro.options.join(", ")}).`;
  return null;
}

/**
 * Normalise a page request into run params (strings only):
 *   { strategy, market, from, to, resolution, settingsSource, custom }
 * Custom values arrive as `s.<PAIR_KEY>=value` query params.
 */
function parseRequest(query) {
  const q = query || {};
  const custom = {};
  for (const k of Object.keys(q)) {
    if (k.startsWith("s.") && /^[A-Z0-9_]+$/.test(k.slice(2))) custom[k.slice(2)] = String(Array.isArray(q[k]) ? q[k][0] : q[k]);
  }
  const strategy = String(q.strategy || "");
  const ro = registry.byId(strategy) ? resolutionOptions(strategy) : null;
  return {
    strategy,
    market: String(q.market || "NIFTY").toUpperCase(),
    from: String(q.from || ""),
    to: String(q.to || ""),
    resolution: ro ? String(q.resolution || ro.default) : null,
    settingsSource: q.settings === "custom" ? "custom" : "current",
    custom: q.settings === "custom" ? custom : {},
  };
}

function _newRecord(id, p, settings, overrides) {
  const s = registry.byId(p.strategy);
  const M = markets.get(p.market);
  return {
    id, jobId: id,
    strategyId: s.id, strategyLabel: s.label, strategyKey: s.key,
    market: M.key, marketLabel: M.label,
    from: p.from, to: p.to, resolution: p.resolution,
    settingsSource: p.settingsSource,
    settings,
    overriddenKeys: Object.keys(overrides),
    startedAt: new Date().toISOString(),
  };
}

/** The renderBacktestResults() options a saved record can carry (JSON-safe). */
function _storableView(v) {
  return {
    mode: v.mode, accent: v.accent, strategyName: v.strategyName,
    summary: v.summary, trades: v.trades,
    extraTradeColumns: (v.extraTradeColumns || []).map((c) => ({ key: c.key, label: c.label })),
    extraStats: (v.extraStats || []).map((e) => ({ label: e.label, value: e.value, color: e.color, sub: e.sub })),
    notes: v.notes || "",
  };
}

/**
 * Start a run. Returns { id } on start, { queued: true } when another backtest
 * holds the slot, { error } on a bad request, { refused } in the demo login.
 */
function start(p) {
  const err = _validate(p);
  if (err) return { error: err };
  if (backtestJobs.getActiveJob()) return { queued: true };
  const s = registry.byId(p.strategy);
  const h = hookOf(s.id);
  const job = backtestJobs.createJob(s.modeKey);
  if (job.refused) return { refused: job.reason, id: job.id };
  if (job.existing) return { queued: true };
  const id = job.id;
  const { overrides, settings } = buildOverrides(s.id, p.market, p.settingsSource === "custom" ? p.custom : null);
  const record = _newRecord(id, p, settings, overrides);
  const entry = { record, finished: false, error: null };
  _runs.set(id, entry);
  for (const k of [..._runs.keys()].slice(0, -10)) _runs.delete(k);

  const params = { from: p.from, to: p.to, market: p.market };
  if (p.resolution) params.resolution = p.resolution;

  Promise.resolve()
    .then(() => scopedEnv.run(overrides, async () => {
      console.log(`🧪 /backtest job ${id}: ${s.label} on ${p.market} ${p.from} → ${p.to}${p.resolution ? ` ${p.resolution}m` : ""} (${p.settingsSource} settings${Object.keys(overrides).length ? `, ${Object.keys(overrides).length} override(s)` : ""})`);
      await h.run(id, params);
      const j = backtestJobs.getJob(id);
      if (!j || j.status !== "done") return;
      // The view reads config (notes, labels) — inside the scope, so it shows
      // the settings this run actually used.
      record.view = _storableView(h.view(j.result, Object.assign({ jobId: id }, params)));
      record.finishedAt = new Date().toISOString();
      resultStore.saveRun(record);
    }))
    .catch((e) => {
      entry.error = e.message || String(e);
      console.error(`[backtest] job ${id} failed after the run:`, e);
      backtestJobs.failJob(id, entry.error);
    })
    .then(() => { entry.finished = true; });

  return { id };
}

/**
 * Page-level status of a run: "running" until the result is SAVED (the
 * engine's completeJob lands a moment before), then the job's own status.
 */
function status(id) {
  const job = backtestJobs.getJob(id);
  const entry = _runs.get(id);
  if (!job) {
    if (resultStore.loadRun(id)) return { status: "done", saved: true };
    return { status: "not_found" };
  }
  const out = { status: job.status, progress: job.progress, elapsed: Date.now() - job.startedAt, error: job.error };
  if (job.status === "done" && entry && !entry.finished) {
    out.status = "running";
    out.progress = { ...job.progress, phase: "Saving results…", pct: 99 };
  }
  if (entry && entry.error) { out.status = "error"; out.error = entry.error; }
  return out;
}

function pending(id) { const e = _runs.get(id); return e ? e.record : null; }

module.exports = {
  hookOf,
  strategies,
  marketOptions,
  resolutionOptions,
  settingsFields,
  buildOverrides,
  parseRequest,
  start,
  status,
  pending,
  NOT_BACKTEST,
};

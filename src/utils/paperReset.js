/**
 * Paper-data reset — discovers every paper engine mounted on the Express app
 * AT CALL TIME, so a strategy added later is reset without touching this file
 * or any UI list. (The Logs-page dialog used to carry a hand-written list of
 * six strategies while fourteen paper engines were mounted — the other eight
 * kept their capital and sessions across a "full" reset.)
 *
 * Discovery rule: an `app.use("/<name>-paper", router)` whose router owns a
 * GET /reset route. Every paper route in the repo follows that shape, and
 * tests/paperReset.regression.js asserts each *Paper.js keeps doing so.
 *
 * The reset itself is delegated to each router's own /reset handler — the
 * canonical capital + sessions + in-memory-state wipe that route already owns —
 * by dispatching a synthetic GET /reset through the router in-process. No HTTP
 * hop, no second auth check, and a running engine is refused by the handler's
 * own guard (reported here as `skipped`).
 *
 * File-level history (daily trade JSONL + skip JSONL) is globbed from disk by
 * filename pattern rather than by a mode list, for the same reason.
 *
 * Settings (.env) are never touched: each /reset handler re-reads its starting
 * capital from process.env and writes only its *_paper_trades.json.
 */
const fs   = require("fs");
const path = require("path");

const DATA_DIR   = path.join(require("os").homedir(), "trading-data");
const TRADES_DIR = path.join(DATA_DIR, "trades");   // mirrors utils/tradeLogger
const SKIPS_DIR  = path.join(DATA_DIR, "skips");    // mirrors utils/skipLogger

// Express 4 stores a mount as a regexp: ^\/bb_rsi-paper\/?(?=\/|$)
const _MOUNT_RE = /^\^\\\/(.+?)\\\/\?\(\?=\\\/\|\$\)$/;
const _PAPER_DAILY_RE = /^(.+)_paper_trades_(\d{4}-\d{2}-\d{2})\.jsonl$/;
const _SKIP_DAILY_RE  = /^(.+)_paper_skips_(\d{4}-\d{2}-\d{2})\.jsonl$/;

function _mountOf(layer) {
  if (!layer || layer.name !== "router" || !layer.regexp) return null;
  const m = _MOUNT_RE.exec(layer.regexp.source);
  return m ? "/" + m[1].replace(/\\(.)/g, "$1") : null;
}

function _hasGetReset(router) {
  const stack = router && router.stack;
  if (!Array.isArray(stack)) return false;
  return stack.some(l => l.route && l.route.path === "/reset" && l.route.methods && l.route.methods.get);
}

function _labelOf(mount) {
  return mount.replace(/^\//, "").replace(/-paper$/, "").replace(/[-_]+/g, " ").toUpperCase();
}

/**
 * Every `/<x>-paper` router with a GET /reset, in mount order.
 * Returns [{ mount, label, layer }].
 */
function discoverTargets(app) {
  const stack = app && app._router && app._router.stack;
  if (!Array.isArray(stack)) return [];
  const out = [];
  for (const layer of stack) {
    const mount = _mountOf(layer);
    if (!mount || !mount.endsWith("-paper")) continue;
    if (!_hasGetReset(layer.handle)) continue;
    out.push({ mount, label: _labelOf(mount), layer });
  }
  return out;
}

/**
 * Run one router's GET /reset in-process. Resolves (never rejects) with
 * { mount, label, ok, skipped, status, message }.
 *   ok      — handler answered 2xx JSON / text, or redirected (all 14 answer
 *             JSON today; a redirect on success is still treated as ok)
 *   skipped — handler refused with 400 (its own "stop the engine first" guard)
 */
function dispatchReset(target, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (status, body) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const text = typeof body === "string" ? body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : "";
      const msg  = body && typeof body === "object" ? (body.message || body.error || "") : text;
      const ok   = status >= 200 && status < 400 && !(body && typeof body === "object" && body.success === false);
      resolve({ mount: target.mount, label: target.label, ok, skipped: !ok && status === 400, status, message: String(msg).slice(0, 200) });
    };
    const timer = setTimeout(() => finish(504, "reset handler did not respond"), timeoutMs);

    const req = {
      method: "GET", url: "/reset", originalUrl: `${target.mount}/reset`, baseUrl: "",
      headers: { "x-paper-reset": "settings" }, query: {}, params: {}, body: {},
      get: () => undefined, is: () => false,
    };
    const res = {
      statusCode: 200, headersSent: false,
      status(c) { this.statusCode = c; return this; },
      set() { return this; }, setHeader() { return this; }, type() { return this; },
      json(o) { finish(this.statusCode, o); },
      send(o) { finish(this.statusCode, o); },
      end(o)  { finish(this.statusCode, o == null ? "" : o); },
      redirect(a, b) { finish(typeof a === "number" ? a : 302, String(b == null ? a : b)); },
      sendFile() { finish(this.statusCode, ""); },
    };
    try {
      target.layer.handle(req, res, (err) => finish(err ? 500 : 404, err ? String(err.message || err) : "no /reset route matched"));
    } catch (e) {
      finish(500, e.message);
    }
  });
}

/** Reset every discovered paper engine, one after another. */
async function resetAllPaperEngines(app) {
  const results = [];
  for (const t of discoverTargets(app)) results.push(await dispatchReset(t));
  return results;
}

/** Mount → mode key used in file names: "/trend-pb-paper" → "trend_pb". */
function modeOfMount(mount) {
  return String(mount || "").replace(/^\//, "").replace(/-paper$/, "").replace(/-/g, "_");
}

/**
 * Delete per-day paper files — trade JSONL and/or skip JSONL — for every mode
 * found on disk, optionally limited to an inclusive IST date range. Both
 * categories are swept unless `paper`/`skip` is passed false. `excludeModes`
 * keeps a running engine's files intact (a skipped engine must stay untouched).
 * Returns { paperFiles, skipFiles, modes: [...], errors: [...] }.
 */
function deletePaperFiles({ from = "", to = "", paper = true, skip = true, excludeModes = [] } = {}) {
  const inRange = (d) => (!from || d >= from) && (!to || d <= to);
  const excluded = new Set(excludeModes);
  const out = { paperFiles: 0, skipFiles: 0, modes: new Set(), errors: [] };
  const sweep = (dir, re, counter) => {
    let names;
    try { names = fs.readdirSync(dir); } catch (_) { return; }
    for (const n of names) {
      const m = re.exec(n);
      if (!m || !inRange(m[2]) || excluded.has(m[1])) continue;
      try { fs.unlinkSync(path.join(dir, n)); out[counter] += 1; out.modes.add(m[1]); }
      catch (e) { if (e.code !== "ENOENT") out.errors.push(`${n}: ${e.message}`); }
    }
  };
  if (paper) sweep(TRADES_DIR, _PAPER_DAILY_RE, "paperFiles");
  if (skip)  sweep(SKIPS_DIR,  _SKIP_DAILY_RE,  "skipFiles");
  out.modes = [...out.modes].sort();
  return out;
}

module.exports = { discoverTargets, dispatchReset, resetAllPaperEngines, deletePaperFiles, modeOfMount };

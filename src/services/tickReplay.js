/**
 * tickReplay.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Deterministic tick-replay engine. Replays a previously recorded paper-trade
 * session by feeding the recorded spot/option/VIX stream into the SAME paper
 * `onTick()` handlers that ran live — making BACKTEST = PAPER = LIVE.
 *
 * Design:
 *   - Paper code is NEVER modified. Replay achieves alignment by monkey-patching
 *     the dependencies paper consumes (socketManager, fyers REST, notifiers,
 *     tradeLogger) so that:
 *       socketManager.start/addCallback → captures the tick callback (no real WS)
 *       fyers.getQuotes(symbol)         → returns recorded option/VIX by replay clock
 *       notify(*) / sendTelegram         → no-op (don't spam during replay)
 *       tradeLogger.appendTradeLog      → diverts to replay-specific JSONL file
 *
 *   - The replay engine then:
 *       1. Loads session-start snapshot, applies settings overrides to env
 *       2. Calls the paper route's /start handler (which now builds state and
 *          registers the captured tick callback)
 *       3. Pumps recorded spot ticks through the captured callback in order,
 *          advancing the replay clock so option-LTP/VIX stubs serve correct values
 *       4. Calls the paper route's /stop handler to flush + summarise
 *       5. Restores all monkey-patches so the process can resume normal use
 *
 * IMPORTANT — concurrency:
 *   Only one replay can run in the same process at a time (since it patches
 *   global modules). The engine takes a process-wide lock and refuses overlap.
 *
 * Usage:
 *   const replay = require("./tickReplay");
 *   const result = await replay.replaySession({
 *     date:      "2026-05-15",
 *     mode:      "pa-paper",     // "pa-paper" | "scalp-paper" | "swing-paper"
 *     sessionId: undefined,      // optional — defaults to first start of the day
 *     speed:     0,              // 0 = as-fast-as-possible, >0 = ms delay between ticks
 *   });
 *   // result = { sessionTrades, sessionPnl, ticksReplayed, durationMs, sessionId, mode }
 * ─────────────────────────────────────────────────────────────────────────────
 */

const fs       = require("fs");
const path     = require("path");
const readline = require("readline");

const { ROOT_DIR } = require("../utils/tickRecorder")._internals;

// ── Process-wide lock so two replays can't trample each other's monkey-patches ─
let _replayInProgress = false;

// ── Loaders ─────────────────────────────────────────────────────────────────

// Sync read (used for small files: sessions.jsonl ≤ ~6 events/day)
function _readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const text = fs.readFileSync(filePath, "utf8");
  if (!text) return [];
  const out = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { out.push(JSON.parse(trimmed)); } catch (_) { /* skip bad lines */ }
  }
  return out;
}

// Stream-read JSONL line-by-line, applying optional filter, with optional
// per-line callback. Keeps memory bounded — never materialises the full file.
//   onRec(rec)        — invoked for each parsed record passing the filter
//   filterFn(rec)     — return true to keep, false to skip
// Returns Promise<count of kept records>.
async function _streamJsonl(filePath, { onRec, filterFn } = {}) {
  if (!fs.existsSync(filePath)) return 0;
  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let kept = 0;
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec;
    try { rec = JSON.parse(trimmed); } catch (_) { continue; }
    if (filterFn && !filterFn(rec)) continue;
    if (onRec) onRec(rec);
    kept += 1;
  }
  return kept;
}

/**
 * Load metadata streams for a recorded day and pick the matching session.
 *
 *   date      — "YYYY-MM-DD" (IST)
 *   mode      — e.g. "pa-paper"
 *   sessionId — optional; if omitted, picks the first start event for that mode
 *
 * Returns: { sessionStart, sessionStop, optionTicks, vixTicks, spotPath }
 *   - sessions.jsonl is small (handful of events), read sync.
 *   - options/vix are loaded into memory (need timeline for binary lookup
 *     by the getQuotes stub) — typical sizes ~14k options × ~70 B = ~1 MB,
 *     vix ~360 × ~30 B = ~12 KB. Cheap.
 *   - spot.jsonl is NOT loaded — `spotPath` is returned for the caller to
 *     stream-iterate (~25k records/day = the only large stream).
 */
async function loadSessionData({ date, mode, sessionId }) {
  if (!date) throw new Error("loadSessionData: date is required");
  if (!mode) throw new Error("loadSessionData: mode is required");

  const dir = path.join(ROOT_DIR, date);
  if (!fs.existsSync(dir)) {
    throw new Error(`No recording found for ${date} at ${dir}`);
  }

  const sessions = _readJsonl(path.join(dir, "sessions.jsonl"));
  const startEvts = sessions.filter(s => s.e === "start" && s.mode === mode);
  if (startEvts.length === 0) {
    throw new Error(`No '${mode}' session-start event found in ${date}`);
  }

  let sessionStart;
  if (sessionId) {
    sessionStart = startEvts.find(s => s.sid === sessionId);
    if (!sessionStart) throw new Error(`sessionId ${sessionId} not found for ${mode} on ${date}`);
  } else {
    sessionStart = startEvts[0];
  }

  let sessionStop = sessions.find(s =>
    s.e === "stop" && s.mode === mode && s.sid === sessionStart.sid && s.t >= sessionStart.t
  );

  const startT = sessionStart.t;
  const stopT  = sessionStop ? sessionStop.t : Infinity;
  const inWindow = (rec) => rec.t >= startT && rec.t <= stopT;
  const byT      = (a, b) => a.t - b.t;

  // Stream options + vix (small but stream them anyway to avoid full-file
  // intermediate string allocation).
  const optionTicks = [];
  const vixTicks    = [];
  await _streamJsonl(path.join(dir, "options.jsonl"), { filterFn: inWindow, onRec: r => optionTicks.push(r) });
  await _streamJsonl(path.join(dir, "vix.jsonl"),     { filterFn: inWindow, onRec: r => vixTicks.push(r) });
  optionTicks.sort(byT);
  vixTicks.sort(byT);

  // If session-stop missing, peek the last spot-tick timestamp as bound.
  // This requires a single streaming pass — cheap and avoids loading.
  if (!sessionStop) {
    let lastT = startT;
    await _streamJsonl(path.join(dir, "spot.jsonl"), {
      filterFn: r => r.t >= startT,
      onRec:    r => { if (r.t > lastT) lastT = r.t; },
    });
    sessionStop = { t: lastT, e: "stop", mode, sid: sessionStart.sid, reason: "synth_eod" };
  }

  return {
    sessionStart,
    sessionStop,
    optionTicks,
    vixTicks,
    spotPath: path.join(dir, "spot.jsonl"),
  };
}

// ── Per-symbol option LTP timeline (for fyers.getQuotes stub) ───────────────
function _buildOptionTimeline(optionTicks) {
  const bySymbol = new Map();
  for (const rec of optionTicks) {
    let arr = bySymbol.get(rec.s);
    if (!arr) { arr = []; bySymbol.set(rec.s, arr); }
    arr.push({ t: rec.t, l: rec.l });
  }
  // Each symbol's array is already in ascending order (input was sorted by t).
  return bySymbol;
}

function _lookupAtOrBefore(arr, t) {
  // Binary search: largest index where arr[i].t <= t. Returns null if none.
  if (!arr || arr.length === 0) return null;
  let lo = 0, hi = arr.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid].t <= t) { ans = mid; lo = mid + 1; }
    else                  hi = mid - 1;
  }
  return ans >= 0 ? arr[ans] : null;
}

// ── Settings override (env snapshot) ────────────────────────────────────────
function _applySettingsOverride(settings) {
  if (!settings) return () => {};
  const original = {};
  for (const k of Object.keys(settings)) {
    original[k] = process.env[k];   // may be undefined
    process.env[k] = settings[k];
  }
  return function restore() {
    for (const k of Object.keys(original)) {
      if (original[k] === undefined) delete process.env[k];
      else                            process.env[k] = original[k];
    }
  };
}

// ── Monkey-patch harness ────────────────────────────────────────────────────
/**
 * Build the harness: install() patches deps, uninstall() restores them.
 * The harness exposes `pumpTick(tick)` for the engine to fan ticks through
 * the captured callbacks.
 */
function _createHarness({ optionTimeline, vixTimeline, warmupCandles }) {
  const socketManager   = require("../utils/socketManager");
  const fyers           = require("../config/fyers");
  const notify          = require("../utils/notify");
  const tradeLogger     = require("../utils/tradeLogger");
  const backtestEngine  = require("./backtestEngine");
  const candleCache     = require("../utils/candleCache");
  const fyersAuthCheck  = require("../utils/fyersAuthCheck");
  const nseHolidays     = require("../utils/nseHolidays");

  const orig = {
    sm_start:        socketManager.start,
    sm_addCallback:  socketManager.addCallback,
    sm_removeCallback: socketManager.removeCallback,
    sm_isRunning:    socketManager.isRunning,
    sm_stop:         socketManager.stop,
    fyers_getQuotes: fyers.getQuotes,
    fyers_getHistory: fyers.getHistory,
    bt_fetchCandles: backtestEngine.fetchCandles,
    cc_fetchCandlesCached: candleCache.fetchCandlesCached,
    tl_appendTradeLog: tradeLogger.appendTradeLog,
    notifyEntry:     notify.notifyEntry,
    notifyExit:      notify.notifyExit,
    notifyStarted:   notify.notifyStarted,
    notifyDayReport: notify.notifyDayReport,
    sendTelegram:    notify.sendTelegram,
    notifyAuthError: notify.notifyAuthError,
    verifyFyersToken: fyersAuthCheck.verifyFyersToken,
    isTradingAllowed: nseHolidays.isTradingAllowed,
    isExpiryDay:      nseHolidays.isExpiryDay,
    DateNow:          Date.now,
  };

  // Captured callbacks (paper modules call socketManager.addCallback / .start)
  const callbacks = []; // [{ id, onTick, onLog }]

  // Replay clock — advanced as ticks are pumped. Used by getQuotes stub.
  let replayNow = 0;
  function setNow(t) { replayNow = t; }

  function install() {
    // socketManager: capture callbacks, do not open a real WS
    socketManager.start = function (symbol, onTick, onLog) {
      if (typeof onTick === "function") callbacks.push({ id: "__primary__", onTick, onLog });
    };
    socketManager.addCallback = function (id, onTick, onLog) {
      callbacks.push({ id, onTick, onLog });
    };
    socketManager.removeCallback = function (id) {
      const idx = callbacks.findIndex(c => c.id === id);
      if (idx >= 0) callbacks.splice(idx, 1);
    };
    socketManager.isRunning = () => callbacks.length > 0;
    socketManager.stop = () => { callbacks.length = 0; };

    // fyers.getQuotes: serve recorded option LTP / VIX based on replayNow
    fyers.getQuotes = async function (symbols) {
      const sym = Array.isArray(symbols) ? symbols[0] : symbols;
      if (!sym) return { s: "no_data", d: [] };

      // VIX path
      if (sym === "NSE:INDIAVIX-INDEX") {
        const v = _lookupAtOrBefore(vixTimeline, replayNow);
        if (!v) return { s: "no_data", d: [] };
        return { s: "ok", d: [{ v: { lp: v.l != null ? v.l : v.v } }] };
      }

      // Option path
      const arr = optionTimeline.get(sym);
      const v = _lookupAtOrBefore(arr, replayNow);
      if (!v) return { s: "no_data", d: [] };
      return { s: "ok", d: [{ v: { lp: v.l } }] };
    };

    // fyers.getHistory + backtestEngine.fetchCandles + candleCache.fetchCandlesCached:
    // intercept warmup-candle preload to return the recorded snapshot. Paper's
    // /start calls fetchCandlesCached(spotSym, res, fromStr, toStr, fetchCandles)
    // — we short-circuit it to return the recorded warmup so replay is fully
    // deterministic (no live REST hit, no dependence on broker uptime).
    fyers.getHistory = async function (_params) {
      // Wrap warmup candles into Fyers history response shape:
      //   { s:"ok", candles: [[ts, open, high, low, close, vol], ...] }
      const rows = (warmupCandles || []).map(c =>
        [c.time, c.open, c.high, c.low, c.close, c.volume || 0]
      );
      return { s: "ok", candles: rows };
    };
    backtestEngine.fetchCandles = async function (_sym, _res, _from, _to) {
      return (warmupCandles || []).slice();
    };
    candleCache.fetchCandlesCached = async function (_sym, _res, _from, _to, _rawFetcher) {
      return (warmupCandles || []).slice();
    };

    // tradeLogger: divert to replay-specific files so we don't pollute the
    // canonical paper log and can compare side-by-side.
    tradeLogger.appendTradeLog = function (mode, trade) {
      try {
        const dir  = path.join(ROOT_DIR, "_replay_trades");
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `${mode}_replay.jsonl`);
        fs.appendFileSync(file, JSON.stringify({ ...trade, _replay: true }) + "\n");
      } catch (_) {}
    };

    // notifications: silence everything during replay
    notify.notifyEntry     = () => {};
    notify.notifyExit      = () => {};
    notify.notifyStarted   = () => {};
    notify.notifyDayReport = () => {};
    notify.sendTelegram    = async () => ({ ok: true, replay: true });
    notify.notifyAuthError = () => {};

    // Bypass start-time gates so replay works after market hours / on holidays
    // / without a valid Fyers token. These are admin gates on /start, not
    // strategy logic — replaying a recorded session is always "allowed".
    fyersAuthCheck.verifyFyersToken = async () => ({ ok: true, replay: true });
    nseHolidays.isTradingAllowed    = async () => ({ allowed: true, reason: "replay" });
    nseHolidays.isExpiryDay         = async () => false; // recorded session was already gated correctly

    // VIX cache reset is fine; let it pass through.
  }

  // Wall-clock override (used briefly during /start so isStartAllowed sees
  // the recorded session-start time as "now"). Caller invokes setWallClock(t)
  // before /start and clearWallClock() right after.
  let _wallOverride = null;
  function setWallClock(t) {
    _wallOverride = t;
    Date.now = function () { return _wallOverride; };
  }
  function clearWallClock() {
    _wallOverride = null;
    Date.now = orig.DateNow;
  }

  function uninstall() {
    socketManager.start             = orig.sm_start;
    socketManager.addCallback       = orig.sm_addCallback;
    socketManager.removeCallback    = orig.sm_removeCallback;
    socketManager.isRunning         = orig.sm_isRunning;
    socketManager.stop              = orig.sm_stop;
    fyers.getQuotes                 = orig.fyers_getQuotes;
    fyers.getHistory                = orig.fyers_getHistory;
    backtestEngine.fetchCandles     = orig.bt_fetchCandles;
    candleCache.fetchCandlesCached  = orig.cc_fetchCandlesCached;
    tradeLogger.appendTradeLog      = orig.tl_appendTradeLog;
    notify.notifyEntry              = orig.notifyEntry;
    notify.notifyExit               = orig.notifyExit;
    notify.notifyStarted            = orig.notifyStarted;
    notify.notifyDayReport          = orig.notifyDayReport;
    notify.sendTelegram             = orig.sendTelegram;
    notify.notifyAuthError          = orig.notifyAuthError;
    fyersAuthCheck.verifyFyersToken = orig.verifyFyersToken;
    nseHolidays.isTradingAllowed    = orig.isTradingAllowed;
    nseHolidays.isExpiryDay         = orig.isExpiryDay;
    Date.now                        = orig.DateNow;
    callbacks.length = 0;
  }

  function pumpTick(tick) {
    setNow(tick.t);
    for (const cb of callbacks) {
      try { cb.onTick(tick); } catch (e) {
        // Eat errors — replay should continue. Log once per error message.
        const k = `__replay_err_${e.message}`;
        if (!pumpTick[k]) {
          console.warn(`[tickReplay] callback error: ${e.message}`);
          pumpTick[k] = true;
        }
      }
    }
  }

  return { install, uninstall, pumpTick, setNow, setWallClock, clearWallClock, getCallbacks: () => callbacks };
}

// ── Mode → route module mapping ─────────────────────────────────────────────
const MODE_TO_MODULE = {
  "pa-paper":    "../routes/paPaper",
  "scalp-paper": "../routes/scalpPaper",
  "swing-paper": "../routes/swingPaper",
  // Live modes are NOT supported for replay (they place real orders). If a
  // live session was recorded, replay it as the matching paper mode.
};

// Helper: invoke a route's /start and /stop handlers programmatically.
// Express requires (req, res) — we pass mock objects.
function _invokeRoute(routeModule, method, urlPath, query = {}) {
  // routeModule is the express Router. We dive into its stack.
  return new Promise((resolve, reject) => {
    let resolved = false;
    const finish = (payload) => {
      if (resolved) return;
      resolved = true;
      resolve(payload);
    };
    const req = {
      method: method.toUpperCase(),
      url: urlPath,
      path: urlPath,
      query,
      headers: { host: "localhost" },
      get: () => undefined,
      app: { get: () => undefined, set: () => {} },
    };
    const res = {
      statusCode: 200,
      _headers: {},
      _body: null,
      status(c) { this.statusCode = c; return this; },
      set(k, v) { this._headers[k] = v; return this; },
      setHeader(k, v) { this._headers[k] = v; return this; },
      json(b)  { this._body = b; finish({ status: this.statusCode, body: b }); return this; },
      send(b)  { this._body = b; finish({ status: this.statusCode, body: b }); return this; },
      redirect(url) { finish({ status: 302, redirect: url }); },
      end(b)   { finish({ status: this.statusCode, body: b }); return this; },
    };
    // Walk the router stack to find the matching route
    const stack = routeModule.stack || [];
    let idx = 0;
    function next(err) {
      if (err) return reject(err);
      if (idx >= stack.length) return finish({ status: 404, body: "no matching route" });
      const layer = stack[idx++];
      try {
        if (layer.route && layer.route.path === urlPath) {
          const methodHandler = layer.route.stack.find(s => s.method === method.toLowerCase());
          if (methodHandler) {
            const ret = methodHandler.handle(req, res, next);
            if (ret && typeof ret.catch === "function") ret.catch(next);
            return;
          }
        }
        next();
      } catch (e) { next(e); }
    }
    next();
  });
}

/**
 * Replay one recorded session end-to-end.
 *
 *   date       — "YYYY-MM-DD"
 *   mode       — "pa-paper" | "scalp-paper" | "swing-paper"
 *   sessionId  — optional
 *   speed      — 0 = as fast as possible, >0 = ms delay between ticks
 *
 * Returns:
 *   { ok, sessionId, mode, ticksReplayed, durationMs, sessionTrades, sessionPnl, error? }
 */
async function replaySession({ date, mode, sessionId, speed = 0 } = {}) {
  if (_replayInProgress) {
    throw new Error("Another replay is already running in this process. Wait for it to finish.");
  }
  _replayInProgress = true;

  const startWall = Date.now();
  let restoreEnv  = () => {};
  let harness     = null;
  let routeMod    = null;

  try {
    if (!MODE_TO_MODULE[mode]) {
      throw new Error(`Unsupported replay mode: ${mode}. Supported: ${Object.keys(MODE_TO_MODULE).join(", ")}`);
    }

    // 1. Load recorded data (metadata + small streams). Spot ticks are NOT
    //    loaded — they're stream-iterated below to keep memory bounded.
    const data = await loadSessionData({ date, mode, sessionId });
    const optionTimeline = _buildOptionTimeline(data.optionTicks);
    const vixTimeline    = data.vixTicks.map(v => ({ t: v.t, l: v.v })); // unify field name

    // 2. Apply settings override from session-start snapshot
    restoreEnv = _applySettingsOverride(data.sessionStart.settings);

    // 3. Install harness (monkey-patch deps) with recorded warmup so paper's
    //    own preloadHistory returns the snapshot ticks instead of hitting the
    //    real Fyers REST.
    const warmupCandles = data.sessionStart.warmup || [];
    harness = _createHarness({ optionTimeline, vixTimeline, warmupCandles });
    harness.install();

    // 4. Load the route module AFTER patches are installed so module-level
    //    state is fresh (Node caches require results — we clear cache for the
    //    route module so its `let state = {...}` reinitialises).
    const routePath = require.resolve(MODE_TO_MODULE[mode]);
    delete require.cache[routePath];
    routeMod = require(MODE_TO_MODULE[mode]);

    // 5. Set replay clock to session start, then call /start handler.
    //    Paper's /start runs unchanged: it'll preload candles (intercepted →
    //    recorded warmup), kick off VIX (intercepted → recorded VIX), and
    //    register the tick callback (intercepted → captured by harness).
    //    Wall-clock is overridden during /start so isStartAllowed() sees the
    //    recorded session-start IST time as "now", which always passes.
    harness.setNow(data.sessionStart.t);
    harness.setWallClock(data.sessionStart.t);
    let startResp;
    try {
      startResp = await _invokeRoute(routeMod, "GET", "/start");
    } finally {
      harness.clearWallClock();
    }
    if (startResp.status >= 400 && startResp.status !== 302) {
      throw new Error(`Route /start returned ${startResp.status}: ${JSON.stringify(startResp.body).slice(0, 200)}`);
    }

    // 6. Stream spot ticks line-by-line and pump through the captured
    //    callback in recorded order. Each tick advances the replay clock so
    //    the LTP/VIX getQuotes stub serves the value that was current then.
    //
    //    EC2 t3.micro guards:
    //      - line-by-line streaming → never materialises the full file
    //      - yield to event loop every YIELD_EVERY ticks → keeps HTTP responsive
    //      - GC every GC_EVERY ticks (if --expose-gc) → bounds heap growth
    const YIELD_EVERY = 200;
    const GC_EVERY    = 2000;
    let ticksReplayed = 0;
    const startT = data.sessionStart.t;
    const stopT  = data.sessionStop.t;

    const spotStream = fs.createReadStream(data.spotPath, { encoding: "utf8" });
    const rl = readline.createInterface({ input: spotStream, crlfDelay: Infinity });
    try {
      for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let tick;
        try { tick = JSON.parse(trimmed); } catch (_) { continue; }
        if (tick.t < startT || tick.t > stopT) continue;

        harness.pumpTick(tick);
        ticksReplayed++;

        if (speed > 0) await new Promise(r => setTimeout(r, speed));
        else if (ticksReplayed % YIELD_EVERY === 0) await new Promise(r => setImmediate(r));
        if (global.gc && ticksReplayed % GC_EVERY === 0) global.gc();
      }
    } finally {
      rl.close();
      spotStream.destroy();
    }

    // 7. Call /stop — squares off any open position via paper's own
    //    simulateSell, finalises the session.
    harness.setNow(data.sessionStop.t);
    const stopResp = await _invokeRoute(routeMod, "GET", "/stop");

    // 8. Read final results from the route's status endpoint. Each paper
    //    mode exposes /status/data returning { trades, sessionPnl, ... }.
    //    Calling this is a normal GET against a paper-defined endpoint —
    //    no internals exposed.
    const statusResp = await _invokeRoute(routeMod, "GET", "/status/data");
    let sessionTrades = [];
    let sessionPnl    = 0;
    let tradeCount    = 0;
    if (statusResp && statusResp.body) {
      sessionTrades = statusResp.body.trades || [];
      sessionPnl    = statusResp.body.sessionPnl != null ? statusResp.body.sessionPnl : 0;
      tradeCount    = statusResp.body.tradeCount != null ? statusResp.body.tradeCount : sessionTrades.length;
    }
    // Fallback for /stop response shape (swingPaper returns session in body)
    if ((!sessionTrades || sessionTrades.length === 0) && stopResp && stopResp.body && stopResp.body.session) {
      const sess = stopResp.body.session;
      sessionTrades = sess.trades || sess.sessionTrades || sessionTrades;
      sessionPnl    = sess.totalPnl != null ? sess.totalPnl : (sess.pnl != null ? sess.pnl : sessionPnl);
      tradeCount    = sessionTrades.length;
    }

    return {
      ok: true,
      mode,
      sessionId: data.sessionStart.sid,
      ticksReplayed,
      durationMs: Date.now() - startWall,
      tradeCount,
      sessionTrades,
      sessionPnl,
    };
  } catch (err) {
    return {
      ok: false,
      mode,
      sessionId: sessionId || null,
      error: err.message,
      durationMs: Date.now() - startWall,
    };
  } finally {
    try { harness && harness.uninstall(); } catch (_) {}
    try { restoreEnv(); } catch (_) {}
    // Drop the route module from the cache so the live-trading process can
    // re-require it cleanly without our patched state.
    if (routeMod) {
      try { delete require.cache[require.resolve(MODE_TO_MODULE[mode])]; } catch (_) {}
    }
    _replayInProgress = false;
  }
}

/**
 * List recorded sessions for a given date (or all available dates if none given).
 */
function listRecordings(date) {
  const out = { dates: [], sessions: [] };
  if (!fs.existsSync(ROOT_DIR)) return out;

  const dates = date ? [date] : fs.readdirSync(ROOT_DIR).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  out.dates = dates;

  for (const d of dates) {
    const sFile = path.join(ROOT_DIR, d, "sessions.jsonl");
    if (!fs.existsSync(sFile)) continue;
    const events = _readJsonl(sFile);
    const starts = events.filter(e => e.e === "start");
    for (const s of starts) {
      const stop = events.find(e => e.e === "stop" && e.sid === s.sid);
      out.sessions.push({
        date:      d,
        mode:      s.mode,
        sessionId: s.sid,
        startTs:   s.t,
        stopTs:    stop ? stop.t : null,
        durationMs: stop ? (stop.t - s.t) : null,
        warmupCandles: s.warmup ? s.warmup.length : 0,
      });
    }
  }
  return out;
}

module.exports = {
  loadSessionData,
  listRecordings,
  replaySession,
  // exposed for tests
  _internals: { _buildOptionTimeline, _lookupAtOrBefore, _createHarness, _invokeRoute, MODE_TO_MODULE },
};

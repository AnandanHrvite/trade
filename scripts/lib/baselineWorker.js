/**
 * baselineWorker.js — one sandboxed child process of scripts/strategyBaseline.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Two jobs, picked by argv:
 *
 *   --generate --ticks DIR --settings FILE
 *       Write the synthetic recordings (spot/options/vix/market/sessions .jsonl,
 *       the format src/utils/tickRecorder.js writes and tickReplay reads) for
 *       every baseline session into DIR.
 *
 *   --mode MODE --date YYYY-MM-DD --ticks DIR --out FILE
 *       Replay ONE paper strategy over ONE synthetic day through the real
 *       src/services/tickReplay.replaySession() and write its trades to FILE.
 *
 * The parent always starts this with HOME, cwd and TMPDIR inside a throwaway
 * temp dir, so everything the routes persist under os.homedir()/trading-data
 * lands there. This file then, BEFORE any src/ module loads:
 *   · blocks every network primitive (http/https/net/tls/dns/fetch/WebSocket) —
 *     a call throws synchronously, so the outcome is deterministic;
 *   · freezes `new Date()` / Date.now() — tickReplay pins Date.now() to the
 *     replayed tick but leaves no-arg `new Date()` on the real clock, which
 *     stamps sessionStart and similar fields with the wall time of the run;
 *   · refuses any file write outside the temp root;
 *   · redirects tickReplay's recording root to DIR (tickReplay reads it from
 *     tickRecorder._internals.ROOT_DIR at load — a data property, set here);
 *   · serves broker history (warm-up bars, daily bars for pivots/gaps, VIX
 *     daily) from scripts/lib/syntheticMarket.js instead of Fyers.
 *
 * Nothing under src/ is modified.
 */

"use strict";

const fs   = require("fs");
const path = require("path");
const util = require("util");

const REPO = path.resolve(__dirname, "..", "..");
const SRC  = path.join(REPO, "src");

// ── argv ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const arg  = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const has  = (k) => argv.includes(k);

const TMP_ROOT = process.env.BASELINE_TMP_ROOT;
if (!TMP_ROOT) { console.error("baselineWorker: BASELINE_TMP_ROOT not set"); process.exit(2); }

// Captured before anything can patch them.
const _writeSync     = fs.writeSync;
const _openSync      = fs.openSync;
const _writeFileSync = fs.writeFileSync;

// ── Console → log file (the replay is chatty; keep stdout for the parent) ────
const LOG_PATH = arg("--log") || path.join(TMP_ROOT, `worker-${process.pid}.log`);
const _logFd = _openSync(LOG_PATH, "w");
const _logLine = (...a) => { try { _writeSync(_logFd, util.format(...a) + "\n"); } catch (_) {} };
console.log = console.info = console.warn = console.error = console.debug = _logLine;

// ── 1. Network block ─────────────────────────────────────────────────────────
const blockedCalls = [];
function _blocked(name) {
  return function blockedNetworkCall(...a) {
    let target = "";
    try {
      const o = a[0];
      target = typeof o === "string" ? o : (o && (o.href || o.host || o.hostname || (o.port && `:${o.port}`))) || "";
    } catch (_) {}
    blockedCalls.push(`${name} ${target}`.trim());
    throw new Error(`[baseline] network blocked: ${name} ${target}`);
  };
}
for (const modName of ["http", "https"]) {
  const m = require(modName);
  m.request = _blocked(`${modName}.request`);
  m.get     = _blocked(`${modName}.get`);
}
{
  const net = require("net");
  net.connect = net.createConnection = _blocked("net.connect");
  net.Socket.prototype.connect = _blocked("net.Socket.connect");
  const tls = require("tls");
  tls.connect = _blocked("tls.connect");
  const dns = require("dns");
  dns.lookup = (host, o, cb) => {
    const done = typeof o === "function" ? o : cb;
    blockedCalls.push(`dns.lookup ${host}`);
    const e = new Error(`[baseline] network blocked: dns.lookup ${host}`);
    e.code = "ENOTFOUND";
    if (typeof done === "function") process.nextTick(() => done(e));
  };
  dns.promises.lookup = async (host) => { blockedCalls.push(`dns.promises.lookup ${host}`); throw new Error("[baseline] network blocked"); };
}
globalThis.fetch = async (u) => { blockedCalls.push(`fetch ${u}`); throw new Error(`[baseline] network blocked: fetch ${u}`); };
globalThis.WebSocket = class { constructor(u) { blockedCalls.push(`WebSocket ${u}`); throw new Error("[baseline] network blocked: WebSocket"); } };

// ── 2. Write guard: nothing may be written outside the temp root ─────────────
const writeViolations = [];
const _TMP_PREFIX = path.resolve(TMP_ROOT) + path.sep;
function _outside(p) {
  try {
    const s = typeof p === "number" ? null : String(p);
    if (s === null) return false;                    // fd-based write
    const r = path.resolve(s);
    return !(r + path.sep).startsWith(_TMP_PREFIX) && r !== "/dev/null";
  } catch (_) { return false; }
}
function _guard(obj, name, argIdx = 0) {
  const orig = obj[name];
  if (typeof orig !== "function") return;
  obj[name] = function guardedWrite(...a) {
    if (_outside(a[argIdx])) {
      writeViolations.push(`${name} ${a[argIdx]}`);
      throw new Error(`[baseline] write outside the sandbox refused: ${name} ${a[argIdx]}`);
    }
    return orig.apply(this, a);
  };
}
for (const n of ["writeFileSync", "appendFileSync", "unlinkSync", "mkdirSync", "rmSync", "createWriteStream",
                 "writeFile", "appendFile", "unlink", "mkdir", "rm"]) _guard(fs, n);
_guard(fs, "renameSync", 1); _guard(fs, "rename", 1); _guard(fs, "copyFileSync", 1); _guard(fs, "copyFile", 1);
for (const n of ["writeFile", "appendFile", "unlink", "mkdir", "rm"]) _guard(fs.promises, n);
_guard(fs.promises, "rename", 1); _guard(fs.promises, "copyFile", 1);

// ── 3. Frozen clock ──────────────────────────────────────────────────────────
// No-arg `new Date()` / `Date()` read Date.now(), which tickReplay overrides with
// the replayed tick time while a run is live. Outside that window it returns
// `_fallbackNow` (set to the session's start instant below), never the real clock.
const RealDate = Date;
let _fallbackNow = RealDate.UTC(2026, 9, 5, 3, 44, 0);
function FrozenDate(...args) {
  if (!new.target) return new RealDate(FrozenDate.now()).toString();
  if (args.length === 0) return new RealDate(FrozenDate.now());
  return new RealDate(...args);
}
Object.setPrototypeOf(FrozenDate, RealDate);
FrozenDate.prototype = RealDate.prototype;
FrozenDate.now   = () => _fallbackNow;
FrozenDate.parse = RealDate.parse;
FrozenDate.UTC   = RealDate.UTC;
global.Date = FrozenDate;

// ── 3b. Real-time timers ─────────────────────────────────────────────────────
// tickReplay collapses short setTimeout delays (≤30 s) to "next turn" and lets
// longer ones run on the REAL clock — fine on the server, where a replay takes
// seconds and a 60 s retry or a 6 h auto-stop never comes due. Here it would
// make the result depend on how fast the machine is. So a delay > 30 s never
// fires (exactly what a fast run sees), and setInterval never ticks: no paper
// decision may hang off wall-clock time inside a replay.
const parkedTimers = { timeout: 0, interval: 0 };
{
  const _st = global.setTimeout, _si = global.setInterval;
  const _parked = () => { const h = _st(() => {}, 2147483647); if (h && h.unref) h.unref(); return h; };
  global.setTimeout = function (cb, delay, ...rest) {
    if (typeof delay === "number" && delay > 30000) { parkedTimers.timeout++; return _parked(); }
    return _st(cb, delay, ...rest);
  };
  global.setInterval = function () { parkedTimers.interval++; return _parked(); };
  void _si;
}

// ── 4. Environment: nothing from the operator's shell or .env may leak in ────
// The parent already starts us with a minimal env; belt and braces.
for (const k of ["APP_ID", "ACCESS_TOKEN", "SECRET_KEY", "ZERODHA_API_KEY", "ZERODHA_ACCESS_TOKEN",
                 "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"]) delete process.env[k];

const market = require("./syntheticMarket");

// ── helpers ──────────────────────────────────────────────────────────────────
const IST = market.IST_OFFSET_MS;
const istDate = (ms) => new RealDate(ms + IST).toISOString().slice(0, 10);
const istMs   = (date, hh, mm, ss = 0) => RealDate.parse(`${date}T00:00:00Z`) - IST + ((hh * 60 + mm) * 60 + ss) * 1000;

function _writeJsonl(file, rows) {
  const fd = _openSync(file, "w");
  let buf = [];
  for (const r of rows) {
    buf.push(JSON.stringify(r));
    if (buf.length >= 5000) { _writeSync(fd, buf.join("\n") + "\n"); buf = []; }
  }
  if (buf.length) _writeSync(fd, buf.join("\n") + "\n");
  fs.closeSync(fd);
}

// ═════════════════════════════════════════════════════════════════════════════
//  --generate
// ═════════════════════════════════════════════════════════════════════════════
// ── --generate --market KEY: a (strategy, market) pair's recording ──────────
// One day file per market (its own ticks dir), so the NIFTY recording above is
// untouched. BANKNIFTY / SENSEX get their own synthetic chain
// (syntheticMarket.forMarket), their own spot symbol + idx, option chain on their
// grid and expiry (src/config/markets — NSE/BSE holiday-preponed), and a Market
// Context Snapshot with `underlyings[U]` so replay pins that market's expiry.
// NIFTY_FUT replays NIFTY's own ticks (the future is priced at the index).
// India VIX is the one global series, NIFTY's.
function generateMarket(mk) {
  const ticksDir = arg("--ticks");
  const spec = JSON.parse(fs.readFileSync(arg("--settings"), "utf8"));
  const instrument = require(path.join(SRC, "config", "instrument"));
  const markets = require(path.join(SRC, "config", "markets"));
  const NIFTY_SPOT = "NSE:NIFTY50-INDEX";
  const M = markets.get(mk);
  const U = instrument.underlyingOf(M.underlying);
  const chain = mk === "NIFTY_FUT" ? market.forMarket("NIFTY") : market.forMarket(U.key);
  const SPOT = U.spot;
  const summary = [];
  for (const sess of market.SESSIONS) {
    const dir = path.join(ticksDir, sess.date);
    fs.mkdirSync(dir, { recursive: true });
    const nTicks = market.dayTicks(sess.date);          // NIFTY — drives India VIX
    const ticks = chain.dayTicks(sess.date);
    _writeJsonl(path.join(dir, "spot.jsonl"), ticks.map(tk => ({ t: tk.t, symbol: SPOT, ltp: tk.ltp, idx: SPOT })));
    const vix = [];
    let ti = 0;
    for (let t = istMs(sess.date, 9, 14); t <= istMs(sess.date, 15, 30); t += 60000) {
      while (ti + 1 < nTicks.length && nTicks[ti + 1].t <= t) ti++;
      vix.push({ t, v: market.vixAt(sess.date, t, nTicks[ti].ltp) });
    }
    _writeJsonl(path.join(dir, "vix.jsonl"), vix);

    // The market's live contract on that morning, as the engines resolve it.
    const info = markets.expiryInfo(mk === "NIFTY_FUT" ? "NIFTY" : mk, `${sess.date}T09:20`);
    const expiry = info.date;
    const [ey, em, ed] = expiry.split("-").map(Number);
    const code = instrument.expiryCodeFor(new RealDate(ey, em - 1, ed), U);
    const opts = [];
    if (M.kind === "options") {
      const step = U.strikeStep;
      const band = step * 12;
      ti = 0;
      let vi = 0;
      for (let t = ticks[0].t; t <= ticks[ticks.length - 1].t; t += spec.optionEveryMs) {
        while (ti + 1 < ticks.length && ticks[ti + 1].t <= t) ti++;
        while (vi + 1 < vix.length && vix[vi + 1].t <= t) vi++;
        const spot = ticks[ti].ltp;
        const atm = Math.round(spot / step) * step;
        for (let k = atm - band; k <= atm + band; k += step) {
          for (const side of ["CE", "PE"]) {
            const l = market.optionPremium(spot, k, side, t, expiry, vix[vi].v);
            // Wider books than NIFTY's: a one-point spread above ₹100 premium.
            const half = l < 20 ? 0.1 : l < 100 ? 0.25 : 0.5;
            opts.push({ t, s: `${U.exchange}:${U.optPrefix}${code}${k}${side}`, l, b: market.round05(Math.max(0.05, l - half)), a: market.round05(l + half), src: "baseline" });
          }
        }
      }
    }
    _writeJsonl(path.join(dir, "options.jsonl"), opts);

    const nInfo = markets.expiryInfo("NIFTY", `${sess.date}T09:20`);
    const monthly = (() => {
      const lastDow = instrument.monthlyExpiryAt(new RealDate(+sess.date.slice(0, 4), +sess.date.slice(5, 7) - 1, +sess.date.slice(8, 10), 9, 20), U);
      return require(path.join(SRC, "utils", "nseHolidays")).formatDateToYYYYMMDD(require(path.join(SRC, "utils", "nseHolidays")).preponedExpirySync(lastDow));
    })();
    _writeJsonl(path.join(dir, "market.jsonl"), [{
      t: istMs(sess.date, 9, 10), e: "market_context", schemaVersion: 1, recorderVersion: "baseline",
      date: sess.date, index: NIFTY_SPOT, underlying: "NIFTY", exchange: "NSE", instrument: "NIFTY_OPTIONS",
      strikeInterval: 50, weeklyExpiriesExist: true,
      weeklyExpiry: nInfo.date, weeklyExpiryCode: nInfo.code,
      monthlyExpiry: market.monthlyExpiryOf(sess.date), dataBroker: "fyers",
      underlyings: { [U.key]: {
        index: SPOT, underlying: U.key, strikeInterval: U.strikeStep, lotSize: U.lotSize,
        weeklyExpiriesExist: U.weekly, weeklyExpiry: U.weekly ? expiry : null, weeklyExpiryCode: U.weekly ? code : null,
        monthlyExpiry: monthly,
      } },
    }]);

    const startT = istMs(sess.date, ...spec.sessionStart);
    const stopT  = istMs(sess.date, ...spec.sessionStop);
    const rows = [];
    for (const mode of spec.modes) {
      const sid = `baseline:${mode}:${sess.date}`;
      rows.push({ t: startT, e: "start", mode, sid, settings: spec.settings, warmup: [], vix: sess.vix,
                  meta: { baseline: true, recordsOptionLtps: true, regime: sess.regime, market: mk } });
      rows.push({ t: stopT, e: "stop", mode, sid, reason: "baseline_eod" });
    }
    _writeJsonl(path.join(dir, "sessions.jsonl"), rows);
    summary.push({ date: sess.date, regime: sess.regime, market: mk, spotTicks: ticks.length, optionTicks: opts.length, expiry, expiryCode: code });
  }
  _writeFileSync(arg("--out"), JSON.stringify({ ok: true, summary }, null, 2));
}

function generate() {
  if (arg("--market")) return generateMarket(String(arg("--market")).toUpperCase());
  const ticksDir = arg("--ticks");
  const spec = JSON.parse(fs.readFileSync(arg("--settings"), "utf8"));   // { settings, modes, sessionStart, sessionStop, optionEveryMs, strikeBand }
  const instrument = require(path.join(SRC, "config", "instrument"));
  const SPOT = "NSE:NIFTY50-INDEX";
  const summary = [];
  for (const sess of market.SESSIONS) {
    const dir = path.join(ticksDir, sess.date);
    fs.mkdirSync(dir, { recursive: true });
    const ticks = market.dayTicks(sess.date);

    // spot.jsonl — the raw websocket tick shape the paper onTick handlers read.
    _writeJsonl(path.join(dir, "spot.jsonl"), ticks.map(tk => ({ t: tk.t, symbol: SPOT, ltp: tk.ltp, idx: SPOT })));

    // vix.jsonl — one sample a minute.
    const vix = [];
    let ti = 0;
    for (let t = istMs(sess.date, 9, 14); t <= istMs(sess.date, 15, 30); t += 60000) {
      while (ti + 1 < ticks.length && ticks[ti + 1].t <= t) ti++;
      vix.push({ t, v: market.vixAt(sess.date, t, ticks[ti].ltp) });
    }
    _writeJsonl(path.join(dir, "vix.jsonl"), vix);

    // options.jsonl — every strike within ±band of spot, both sides, every
    // `optionEveryMs`, priced Black-Scholes off spot + VIX + time to expiry.
    // Symbol code comes from instrument.expiryCodeFor, so it is spelled exactly
    // as validateAndGetOptionSymbol will spell it.
    const [ey, em, ed] = sess.expiry.split("-").map(Number);
    const code = instrument.expiryCodeFor(new RealDate(ey, em - 1, ed));
    const opts = [];
    ti = 0;
    let vi = 0;
    for (let t = ticks[0].t; t <= ticks[ticks.length - 1].t; t += spec.optionEveryMs) {
      while (ti + 1 < ticks.length && ticks[ti + 1].t <= t) ti++;
      while (vi + 1 < vix.length && vix[vi + 1].t <= t) vi++;
      const spot = ticks[ti].ltp;
      const atm = Math.round(spot / 50) * 50;
      for (let k = atm - spec.strikeBand; k <= atm + spec.strikeBand; k += 50) {
        for (const side of ["CE", "PE"]) {
          const l = market.optionPremium(spot, k, side, t, sess.expiry, vix[vi].v);
          const half = l < 20 ? 0.1 : 0.25;
          opts.push({ t, s: `NSE:NIFTY${code}${k}${side}`, l, b: market.round05(Math.max(0.05, l - half)), a: market.round05(l + half), src: "baseline" });
        }
      }
    }
    _writeJsonl(path.join(dir, "options.jsonl"), opts);

    // market.jsonl — the Market Context Snapshot; replay pins the expiry from it.
    _writeJsonl(path.join(dir, "market.jsonl"), [{
      t: istMs(sess.date, 9, 10), e: "market_context", schemaVersion: 1, recorderVersion: "baseline",
      date: sess.date, index: SPOT, underlying: "NIFTY", exchange: "NSE", instrument: "NIFTY_OPTIONS",
      strikeInterval: 50, weeklyExpiriesExist: true,
      weeklyExpiry: sess.expiry, weeklyExpiryCode: code,
      monthlyExpiry: market.monthlyExpiryOf(sess.date), dataBroker: "fyers",
    }]);

    // sessions.jsonl — one start/stop pair per strategy. Empty warm-up on
    // purpose: replay then lets each route fetch its own multi-timeframe
    // history (served by the synthetic history stub), instead of handing every
    // timeframe the same single-resolution series.
    const startT = istMs(sess.date, ...spec.sessionStart);
    const stopT  = istMs(sess.date, ...spec.sessionStop);
    const rows = [];
    for (const mode of spec.modes) {
      const sid = `baseline:${mode}:${sess.date}`;
      rows.push({ t: startT, e: "start", mode, sid, settings: spec.settings, warmup: [], vix: sess.vix,
                  meta: { baseline: true, recordsOptionLtps: true, regime: sess.regime } });
      rows.push({ t: stopT, e: "stop", mode, sid, reason: "baseline_eod" });
    }
    _writeJsonl(path.join(dir, "sessions.jsonl"), rows);
    summary.push({ date: sess.date, regime: sess.regime, spotTicks: ticks.length, optionTicks: opts.length, expiryCode: code });
  }
  _writeFileSync(arg("--out"), JSON.stringify({ ok: true, summary }, null, 2));
}

// ═════════════════════════════════════════════════════════════════════════════
//  replay one (mode, date)
// ═════════════════════════════════════════════════════════════════════════════
const _SPOT_SYMBOLS = /NIFTY50-INDEX/i;
const _VIX_SYMBOLS  = /INDIAVIX/i;
const _isDaily = (res) => ["D", "1D", "W", "M"].includes(String(res || "").toUpperCase());

// --market KEY (a pair replay): that market's spot symbol is served from its own
// synthetic chain; NIFTY 50 / VIX stay NIFTY's.
let _pairSpot = null, _pairChain = null;
function _chainFor(sym) {
  if (_pairSpot && sym === _pairSpot) return _pairChain;
  return _SPOT_SYMBOLS.test(sym) ? market.forMarket("NIFTY") : null;
}

/** Broker-history stand-in. `from`/`to` are IST "YYYY-MM-DD" (or epoch sec). */
function syntheticHistory(symbol, resolution, from, to) {
  const now = Date.now();                     // the replay clock while a run is live
  const today = istDate(now);
  const asDate = (x) => (/^\d+$/.test(String(x)) ? istDate(Number(x) * 1000) : String(x).slice(0, 10));
  const f = asDate(from);
  let t = asDate(to);
  if (t > today) t = today;
  const days = market.tradingDaysBetween(f < market.ANCHOR_DATE ? market.ANCHOR_DATE : f, t);
  const sym = String(symbol || "");
  if (_VIX_SYMBOLS.test(sym)) {
    return _isDaily(resolution) ? days.filter(d => d < today).map(market.vixDailyBar) : [];
  }
  const C = _chainFor(sym);
  if (!C) return [];                          // futures, stocks, another index …: no data
  const sessionToday = market.SESSIONS.some(s => s.date === today);
  if (_isDaily(resolution)) {
    const out = [];
    for (const d of days) {
      if (d < today) { out.push(C.dailyBar(d)); continue; }
      // Today's daily bar, as Fyers serves it mid-session: built from what has traded so far.
      if (sessionToday && now >= market.openMs(d)) {
        const b1 = C.intradayBarsAsOf(d, 1, now);
        if (b1.length) {
          out.push({ time: C.dailyBar(d).time, open: b1[0].open,
                     high: Math.max(...b1.map(b => b.high)), low: Math.min(...b1.map(b => b.low)),
                     close: b1[b1.length - 1].close, volume: 0 });
        }
      }
    }
    return out;
  }
  const res = parseInt(resolution, 10);
  if (!Number.isFinite(res) || res <= 0) return [];
  const out = [];
  for (const d of days) {
    if (d < today) out.push(...C.intradayBars(d, res));
    else if (sessionToday) out.push(...C.intradayBarsAsOf(d, res, now));   // closed bars + the forming one
  }
  return out;
}

async function replayOne() {
  const mode = arg("--mode"), date = arg("--date"), ticksDir = arg("--ticks"), outFile = arg("--out");
  const sess = market.SESSIONS.find(s => s.date === date);
  if (!sess) throw new Error(`unknown session date ${date}`);
  _fallbackNow = istMs(date, 9, 14);
  if (arg("--market")) {
    const mk = String(arg("--market")).toUpperCase();
    const markets = require(path.join(SRC, "config", "markets"));
    const M = markets.get(mk);
    _pairSpot  = require(path.join(SRC, "config", "instrument")).underlyingOf(M.underlying).spot;
    _pairChain = mk === "NIFTY_FUT" ? market.forMarket("NIFTY") : market.forMarket(M.underlying);
  }

  // Recording root → the synthetic recordings. Must precede requiring tickReplay.
  const tickRecorder = require(path.join(SRC, "utils", "tickRecorder"));
  tickRecorder._internals.ROOT_DIR = path.resolve(ticksDir);

  // History stubs. tickReplay's harness captures these as its "originals" and,
  // because the recordings carry no warm-up, passes every fetch through to them.
  const fyers = require(path.join(SRC, "config", "fyers"));
  const backtestEngine = require(path.join(SRC, "services", "backtestEngine"));
  const candleCache = require(path.join(SRC, "utils", "candleCache"));
  backtestEngine.fetchCandles = async (sym, res, from, to) => syntheticHistory(sym, res, from, to);
  candleCache.fetchCandlesCached = async (sym, res, from, to) => syntheticHistory(sym, res, from, to);
  fyers.getHistory = async (p = {}) => {
    const rows = syntheticHistory(p.symbol, p.resolution, p.range_from, p.range_to)
      .map(c => [c.time, c.open, c.high, c.low, c.close, c.volume || 0]);
    return { s: "ok", candles: rows };
  };
  // Pre-harness quote stub (the harness replaces it with the recorded timeline).
  fyers.getQuotes = async () => ({ s: "no_data", d: [] });
  for (const n of ["getOptionChain", "getMarketDepth", "get_profile", "getProfile", "get_funds", "getFunds"]) {
    fyers[n] = async () => ({ s: "error", code: -1, message: "baseline: broker unavailable" });
  }

  const replay = require(path.join(SRC, "services", "tickReplay"));
  // Three of the 17 NIFTY paper routes are not in tickReplay's mode table yet
  // ("not replayable (paper only)"). Register them for this process only — the
  // table is the exported object itself, so no src/ edit is needed. Paths are
  // resolved by tickReplay's own require(), i.e. relative to src/services/.
  const MODES = replay._internals.MODE_TO_MODULE;
  const EXTRA = {
    "st_rsi_piv_bb-paper": "../routes/stRsiPivBbPaper",
    "pivot_ema_st-paper":  "../routes/pivotEmaStPaper",
    "gap_runaway-paper":   "../routes/gapRunawayPaper",
  };
  for (const [m, p] of Object.entries(EXTRA)) if (!MODES[m]) MODES[m] = p;

  const res = await replay.replaySession({ date, mode, noCache: true });
  _fallbackNow = istMs(date, 15, 30);

  const trades = (res.sessionTrades || []).map(t => {
    const { _replayOptionWindow, ...rest } = t || {};
    return rest;
  });
  const skip = res.skipSummary || {};
  const out = {
    ok: !!res.ok,
    error: res.error || null,
    mode, date, regime: sess.regime,
    ticksReplayed: res.ticksReplayed || 0,
    tradeCount: res.tradeCount != null ? res.tradeCount : trades.length,
    sessionPnl: res.sessionPnl != null ? res.sessionPnl : null,
    warmupBlind: !!res.warmupBlind,
    trades,
    skips: { total: skip.total || 0, dropped: skip.dropped || 0, noSignalCandles: skip.noSignalCandles || 0,
             blockedSignals: skip.blockedSignals || 0, byGate: skip.byGate || [] },
    // Diagnostics, not part of the golden comparison.
    _diag: { blockedNetwork: blockedCalls.slice(0, 50), blockedNetworkCount: blockedCalls.length,
             writeViolations: writeViolations.slice(0, 50), parkedTimers, engineLog: (res.engineLog || []).slice(0, 80) },
  };
  _writeFileSync(outFile, JSON.stringify(out));
}

(async () => {
  try {
    if (has("--generate")) generate();
    else await replayOne();
    process.exit(0);
  } catch (e) {
    _logLine("FATAL", e && e.stack || e);
    try { _writeFileSync(arg("--out"), JSON.stringify({ ok: false, error: String(e && e.stack || e) })); } catch (_) {}
    process.exit(1);
  }
})();

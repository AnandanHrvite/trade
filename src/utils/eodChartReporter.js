/**
 * eodChartReporter.js — end-of-day chart images to Telegram
 * ─────────────────────────────────────────────────────────────────────────────
 * After market close, sends ONE chart image per strategy that actually booked a
 * trade today: the day's candles with the same entry/exit markers the paper page
 * draws. Strategies that sat flat send nothing — a picture of an empty session
 * is noise.
 *
 * "Traded" is decided by the persisted paper-trade files (the same loadAllTrades()
 * the 15:32 text report counts), never by the drawn markers — PA draws swing and
 * pivot circles on a flat session, and several strategies draw a PE entry above
 * the bar and an exit as a circle, so markers cannot identify a real trade.
 *
 * How the data is obtained
 * ────────────────────────
 * Each paper router already owns a GET /status/chart-data endpoint that returns
 * `{ candles, markers, ... }` built from that strategy's live session state. We
 * call that handler DIRECTLY, in-process, with a stub req/res — no HTTP, so no
 * login cookie, no self-signed-TLS handshake against ourselves, and no port
 * guessing. It also means the image is built from byte-identical data to the web
 * chart: if the page shows it, this shows it.
 *
 * Paper routes are canonical (see CLAUDE.md) and are NOT modified by this file —
 * it is a pure reader.
 *
 * Timing: fires at 15:34 IST, two minutes after the consolidated text report
 * (15:32) so the day's summary lands first and the charts follow it.
 *
 * Gated by TG_EOD_CHARTS (plus master TG_ENABLED) and, per strategy, by that
 * strategy's own {GROUP}_MODE_ENABLED.
 */

const fs   = require("fs");
const path = require("path");
const { sendTelegramPhoto, canSend, isModeEnabled } = require("./notify");
const { renderChartPng } = require("./chartPng");
const { isNonTradingDay } = require("./nseHolidays");
const { loadAllTrades } = require("../routes/consolidation");

const DATA_DIR   = path.join(require("os").homedir(), "trading-data");
const STATE_FILE = path.join(DATA_DIR, ".eod_charts_state.json");

// 15:34 IST — after the 15:30 square-off and the 15:32 consolidated text report.
const REPORT_HOUR = 15;
const REPORT_MIN  = 34;

/**
 * The strategies we can chart, in the order they're sent.
 *
 * `group`  — the notify.js mode group, so {GROUP}_MODE_ENABLED gates it.
 * `label`  — human title drawn on the image.
 * `module` — paper router module path; its /status/chart-data is what we call.
 * `overlay`— optional field name in the chart-data payload to draw as a line
 *            (e.g. TREND_PB exposes a VWAP series). Omitted where the page
 *            has no single obvious primary line.
 */
const STRATEGIES = [
  { group: "EMA_RSI_ST",   label: "EMA RSI ST",        module: "../routes/emaRsiStPaper" },
  { group: "BB_RSI",       label: "BB RSI",            module: "../routes/bbRsiPaper",       overlay: "bbMiddle" },
  { group: "PA",           label: "Price Action",      module: "../routes/paPaper" },
  { group: "ORB",          label: "ORB",               module: "../routes/orbPaper" },
  { group: "EMA9VWAP",     label: "EMA9 VWAP",         module: "../routes/ema9vwapPaper" },
  { group: "TREND_PB",     label: "Trend Pullback",    module: "../routes/trendPbPaper",     overlay: "vwapLine" },
  { group: "TDS",          label: "Trend Day Scalp",   module: "../routes/trendDayScalpPaper" },
  { group: "RSI_PIVOT_ST", label: "RSI Pivot ST",      module: "../routes/rsiPivotStPaper" },
  // Same engine on NIFTY BANK.
  { group: "BN_PIVOT_RSI_ST", label: "BN Pivot RSI ST", module: "../routes/bnPivotRsiStPaper" },
  // The EMA_RSI_ST clone with a SuperTrend-only stop — its own paper route.
  { group: "EMA_RSI_ST_V2", label: "EMA_RSI_ST_V2", module: "../routes/emaRsiStV2Paper" },
  // The same engine on NIFTY BANK — its own paper route, its own chart.
  { group: "BN_EMA_RSI_ST_V2", label: "BN_EMA_RSI_ST_V2 (NIFTY BANK)", module: "../routes/bnEmaRsiStV2Paper" },
  // SIMPLE_9:30 draws the OPTION PREMIUM of the leg it held, not a spot chart —
  // that is the only chart any of its rules read.
  { group: "SIMPLE930",    label: "SIMPLE 9:30",       module: "../routes/simple930Paper" },
];

function istNow() {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
}

function istDateStr() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

function readLastSentDate() {
  try {
    return (JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) || {}).lastSentDate || null;
  } catch (_) {
    return null;
  }
}

function writeLastSentDate(date) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({ lastSentDate: date }));
  } catch (err) {
    console.warn(`[EOD-CHART] could not persist state: ${err.message}`);
  }
}

/**
 * Find a router's GET /status/chart-data handler inside its Express stack.
 * Matching on the layer regexp rather than an exported symbol keeps this file
 * read-only with respect to the paper routes.
 */
function findChartDataHandler(router) {
  const stack = (router && router.stack) || [];
  for (const layer of stack) {
    if (!layer || !layer.route) continue;
    const p = layer.route.path;
    if (p !== "/status/chart-data") continue;
    if (!layer.route.methods || !layer.route.methods.get) continue;
    const handlers = (layer.route.stack || []).map(l => l.handle).filter(Boolean);
    if (handlers.length) return handlers[handlers.length - 1];
  }
  return null;
}

/**
 * Invoke a chart-data handler with a stub req/res and resolve its JSON payload.
 * Never rejects: a strategy whose endpoint throws or stalls simply yields null
 * and is skipped, so one bad route can't cost the user every other chart.
 */
function callChartData(handler, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } };
    const timer = setTimeout(() => done(null), timeoutMs);

    // Minimal Express-shaped stubs — chart-data handlers only read query params
    // and reply via res.json(). status()/send() are present so an error path
    // inside a handler resolves cleanly instead of throwing on a missing method.
    const req = { query: {}, params: {}, headers: {}, method: "GET", body: {} };
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      set() { return this; },
      setHeader() { return this; },
      type() { return this; },
      json(payload) { done(this.statusCode === 200 ? payload : null); return this; },
      send(payload) {
        if (payload && typeof payload === "object") return this.json(payload);
        done(null);
        return this;
      },
      end() { done(null); return this; },
    };

    try {
      Promise.resolve(handler(req, res, () => done(null))).catch(() => done(null));
    } catch (_) {
      done(null);
    }
  });
}

/** Pull a named overlay series out of a chart-data payload, if present and usable. */
function pickOverlay(payload, field) {
  if (!field) return null;
  const series = payload && payload[field];
  if (!Array.isArray(series) || series.length < 2) return null;
  const clean = series.filter(p => p && Number.isFinite(p.value) && p.time != null);
  return clean.length >= 2 ? clean : null;
}

/**
 * How many trades each strategy actually booked today, by mode key.
 *
 * Read from the persisted paper-trade files via the Consolidation page's
 * loadAllTrades() — the exact source the 15:32 text report counts from, so the
 * two EOD messages can never disagree about who traded.
 *
 * Markers are NOT a usable substitute: PA decorates its chart with swing-point
 * and pattern-pivot circles, and several strategies draw a PE entry `aboveBar`
 * and an exit as a `circle`, so neither marker position nor shape identifies a
 * real trade.
 */
function todaysTradeCounts(istDate) {
  const counts = new Map();
  try {
    for (const t of loadAllTrades()) {
      if (!t || t.date !== istDate) continue;
      const c = counts.get(t.mode) || { entries: 0, exits: 0 };
      c.entries++;
      if (t.exitTime || Number.isFinite(t.exitPrice)) c.exits++;
      counts.set(t.mode, c);
    }
  } catch (err) {
    // A failed read must not silently mute every chart, so surface it loudly.
    console.warn(`[EOD-CHART] could not read today's trades: ${err.message}`);
  }
  return counts;
}

/**
 * Build the chart for one strategy. Returns { png, caption } or null when the
 * strategy is disabled, took no trade today, or has no drawable candles.
 *
 * `counts` is the booked-trade tally from todaysTradeCounts().
 */
async function buildStrategyChart(cfg, istDate, counts) {
  if (!isModeEnabled(cfg.group)) return null;

  // The whole point of the feature: only strategies that actually traded.
  // Checked before doing any chart work so a flat strategy costs nothing.
  const tally = counts.get(cfg.group);
  if (!tally || tally.entries === 0) return null;

  let router;
  try {
    router = require(cfg.module);
  } catch (err) {
    console.warn(`[EOD-CHART] ${cfg.label}: router load failed — ${err.message}`);
    return null;
  }

  const handler = findChartDataHandler(router);
  if (!handler) {
    console.warn(`[EOD-CHART] ${cfg.label}: no /status/chart-data handler found — skipped.`);
    return null;
  }

  const payload = await callChartData(handler);
  if (!payload) return null;

  const candles = Array.isArray(payload.candles) ? payload.candles : [];
  const markers = Array.isArray(payload.markers) ? payload.markers : [];

  if (candles.length < 2) return null;

  // Caption numbers come from the booked trades, not the drawn markers.
  const entries = tally.entries;
  const exits   = tally.exits;
  const caption =
    `${cfg.label} — Paper ${istDate}\n` +
    `${entries} ${entries === 1 ? "entry" : "entries"}, ${exits} ${exits === 1 ? "exit" : "exits"}`;

  const png = renderChartPng({
    title:    `${cfg.label} - Paper`,
    subtitle: `${istDate}  |  ${entries} entries  |  ${exits} exits`,
    candles,
    markers,
    overlay:  pickOverlay(payload, cfg.overlay),
  });
  if (!png) return null;

  return { png, caption };
}

/** Force-send today's charts (no idempotency / time / holiday checks).
 *  Exported for the manual trigger; resolves to the number of images sent. */
async function sendEodCharts() {
  if (!canSend("TG_EOD_CHARTS")) return 0;

  const istDate = istDateStr();
  const counts  = todaysTradeCounts(istDate);
  let sent = 0;

  // Sequential, not parallel: eleven concurrent uploads would hit Telegram's
  // per-chat flood limit and get several images dropped.
  for (const cfg of STRATEGIES) {
    let built = null;
    try {
      built = await buildStrategyChart(cfg, istDate, counts);
    } catch (err) {
      console.warn(`[EOD-CHART] ${cfg.label}: chart build failed — ${err.message}`);
      continue;
    }
    if (!built) continue;

    try {
      const ok = await sendTelegramPhoto(built.png, built.caption);
      if (ok) sent++;
      else console.warn(`[EOD-CHART] ${cfg.label}: upload rejected.`);
    } catch (err) {
      console.warn(`[EOD-CHART] ${cfg.label}: upload threw — ${err.message}`);
    }
  }

  if (sent > 0) console.log(`[EOD-CHART] sent ${sent} chart image(s) for ${istDate}.`);
  else          console.log(`[EOD-CHART] no strategy traded on ${istDate} — nothing sent.`);
  return sent;
}

/** Send today's charts iff it's a trading day, now >= 15:34 IST, and they have
 *  not already gone out today. Mirrors consolidatedEodReporter's catch-up so a
 *  post-close redeploy doesn't silently drop the day. */
async function maybeSendForToday() {
  const now     = istNow();
  const istDate = istDateStr();

  if (now.getHours() < REPORT_HOUR ||
      (now.getHours() === REPORT_HOUR && now.getMinutes() < REPORT_MIN)) {
    return;
  }

  if (readLastSentDate() === istDate) return;

  try {
    if (await isNonTradingDay(now)) {
      console.log("[EOD-CHART] Non-trading day — skipping charts.");
      return;
    }
  } catch (err) {
    console.warn(`[EOD-CHART] holiday check failed (${err.message}) — sending anyway.`);
  }

  // Gated off? Leave the date unrecorded so flipping the toggle on still works
  // for a later day, and don't burn the run building images nobody receives.
  if (!canSend("TG_EOD_CHARTS")) return;

  await sendEodCharts();
  // Record the date even when zero images went out: on a flat day there is
  // genuinely nothing to send, and retrying every tick would rebuild all eleven
  // charts for the rest of the evening.
  writeLastSentDate(istDate);
}

let _timer = null;

function msUntilNextReportIST() {
  const now    = istNow();
  const target = new Date(now);
  target.setHours(REPORT_HOUR, REPORT_MIN, 0, 0);
  let delta = target.getTime() - now.getTime();
  if (delta <= 0) delta += 24 * 60 * 60 * 1000;
  return delta;
}

function scheduleNext() {
  if (_timer) clearTimeout(_timer);
  _timer = setTimeout(async () => {
    // `finally` so a failed send can never kill the schedule for the rest of the
    // process's life — the same trap consolidatedEodReporter documents.
    try { await maybeSendForToday(); }
    catch (err) { console.error(`[EOD-CHART] scheduled run failed: ${(err && err.message) || err}`); }
    finally { scheduleNext(); }
  }, msUntilNextReportIST());
  if (_timer.unref) _timer.unref();
}

function start() {
  maybeSendForToday().catch((err) =>
    console.error("[EOD-CHART] boot catch-up failed:", (err && err.message) || err));
  scheduleNext();
}

module.exports = { start, sendEodCharts, STRATEGIES };

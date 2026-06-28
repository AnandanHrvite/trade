/**
 * notify.js — Telegram trade alerts
 * ─────────────────────────────────────────────────────────────────────────────
 * Setup (one-time):
 *   1. Message @BotFather on Telegram → /newbot → copy the BOT_TOKEN
 *   2. Message your new bot once, then open:
 *      https://api.telegram.org/bot<BOT_TOKEN>/getUpdates
 *      Copy the "id" from chat.id → that is your CHAT_ID
 *   3. Add to .env:
 *        TELEGRAM_BOT_TOKEN=123456:ABCdef...
 *        TELEGRAM_CHAT_ID=987654321
 *
 * Toggle hierarchy:
 *   TG_ENABLED                                  — master gate; if false, nothing sends
 *   TG_{SWING|SCALP|PA|ORB}_STARTED             — session-start alerts (per mode)
 *   TG_{SWING|SCALP|PA|ORB}_ENTRY               — trade entry alerts (per mode)
 *   TG_{SWING|SCALP|PA|ORB}_EXIT                — trade exit alerts (per mode)
 *   TG_{SWING|SCALP|PA}_SIGNALS                 — candle-close skip/signal alerts (Swing/Scalp/PA only)
 *   TG_{SWING|SCALP|PA|ORB}_DAYREPORT           — per-mode day report on session stop
 *   TG_DAYREPORT_CONSOLIDATED                   — one combined day report at market close
 *
 *   (ORB emits no SIGNAL alerts, so it has no _SIGNALS toggle.)
 *
 * If TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID are missing, all functions silently
 * do nothing — no errors.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const https = require("https");
const { spawnSync } = require("child_process");

function isConfigured() {
  return !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);
}

// ── Telegram delivery health ────────────────────────────────────────────────
// Telegram can be unreachable for reasons outside the bot's control (e.g. a
// govt-imposed block, a firewall, an expired token). Sends must NEVER throw or
// hang the trading process, so every send swallows its error — but a silently
// swallowed error means the user stops getting alerts without knowing it. We
// track the last failure here and expose it via getTelegramHealth() so the
// dashboard can raise an in-page banner. Process-local; resets on restart and
// clears on the next successful send.
let _lastTgError    = null;  // { message, code, ts } of the most recent failure
let _tgFailCount    = 0;     // consecutive failures since the last success
let _lastTgOkTs     = null;  // epoch ms of the last successful send

function _recordTgError(message, code) {
  _lastTgError = { message: String(message || "unknown").slice(0, 300), code: code != null ? code : null, ts: Date.now() };
  _tgFailCount += 1;
}

function _recordTgOk() {
  _lastTgError = null;
  _tgFailCount = 0;
  _lastTgOkTs  = Date.now();
}

/**
 * getTelegramHealth() — snapshot for the dashboard banner poll.
 * `ok` is true when configured and the last send did not fail.
 * `lastError` is null when healthy, else { message, code, ts }.
 */
function getTelegramHealth() {
  return {
    configured: isConfigured(),
    ok: isConfigured() && !_lastTgError,
    failCount: _tgFailCount,
    lastError: _lastTgError,
    lastOkTs: _lastTgOkTs,
  };
}

// How long an outbound Telegram request may run before we abort it. A blocked
// or blackholed endpoint (the connection is accepted but never answered) would
// otherwise leave the socket open indefinitely — req.on("error") only fires on
// refused/DNS failures, not on a silent drop. 8s is well above Telegram's
// normal sub-second response.
const TG_REQUEST_TIMEOUT_MS = 8000;

function isOff(v) {
  return v === "false" || v === "0";
}

function isMasterEnabled() {
  return !isOff(process.env.TG_ENABLED);
}

/** Map a mode string ("PAPER", "LIVE", "SCALP-PAPER", "PA-LIVE", "ORB-LIVE (DRY-RUN)", ...) to group.
 *  The dash in "PA-" matters — plain "PAPER" would otherwise be misread as PA.
 *  Live modes can carry a " (DRY-RUN)" suffix, so prefix matching (startsWith) is used.
 */
function modeGroup(mode) {
  if (!mode) return "SWING";
  const m = String(mode).toUpperCase();
  if (m === "SCALP"    || m.startsWith("SCALP-")    || m.startsWith("SCALP_"))    return "SCALP";
  if (m === "PA"       || m.startsWith("PA-")       || m.startsWith("PA_"))       return "PA";
  if (m === "ORB"      || m.startsWith("ORB-")      || m.startsWith("ORB_"))      return "ORB";
  if (m === "EMA9VWAP" || m.startsWith("EMA9VWAP-") || m.startsWith("EMA9VWAP_")) return "EMA9VWAP";
  return "SWING";
}

/** Is a strategy group enabled? Gated by {GROUP}_MODE_ENABLED (default on).
 *  When a strategy is disabled in Settings, none of its alerts should fire and
 *  it should not appear in the consolidated report. */
function isModeEnabled(group) {
  return !isOff(process.env[`${group}_MODE_ENABLED`]);
}

/** Central gate — checks master + specific toggle key. Returns true if allowed. */
function canSend(toggleKey) {
  if (!isConfigured())    return false;
  if (!isMasterEnabled()) return false;
  if (isOff(process.env[toggleKey])) return false;
  return true;
}

/**
 * Send a plain text message to Telegram.
 * Uses MarkdownV2 — special chars are escaped automatically.
 * Does NOT check any toggle — caller is responsible for gating.
 *
 * Returns a Promise that never rejects (errors are logged). Many call sites
 * use `sendTelegram(...).catch(...)`; returning a real Promise is what keeps
 * those safe — calling .catch() on a non-Promise used to throw TypeError
 * and crash the process (notably inside gracefulShutdown).
 */
function sendTelegram(text) {
  if (!isConfigured()) return Promise.resolve();

  // Whole body is wrapped so a malformed payload or a throw inside https.request
  // setup can never escape — sendTelegram must always hand back a settled
  // Promise (call sites chain .catch on it). On any failure we record it for the
  // dashboard and resolve, never reject.
  try {
    const token  = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;

    const escaped = String(text).replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, "\\$1");

    const body = JSON.stringify({
      chat_id:    chatId,
      text:       escaped,
      parse_mode: "MarkdownV2",
    });

    const options = {
      hostname: "api.telegram.org",
      path:     `/bot${token}/sendMessage`,
      method:   "POST",
      timeout:  TG_REQUEST_TIMEOUT_MS,
      headers: {
        "Content-Type":   "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    };

    return new Promise((resolve) => {
      let settled = false;
      const done = () => { if (!settled) { settled = true; resolve(); } };

      const req = https.request(options, (res) => {
        if (res.statusCode !== 200) {
          let raw = "";
          res.on("data", d => { raw += d; });
          res.on("end",  () => {
            const detail = raw.slice(0, 200);
            console.error(`[NOTIFY] Telegram error ${res.statusCode}: ${detail}`);
            _recordTgError(`HTTP ${res.statusCode}: ${detail}`, res.statusCode);
            done();
          });
          res.on("error", () => done());
        } else {
          res.resume();
          res.on("end", () => { _recordTgOk(); done(); });
          res.on("error", () => done());
        }
      });
      // Abort a hung connection (banned/blackholed endpoint) instead of leaking
      // the socket. destroy() fires the "error" handler below with this error.
      req.on("timeout", () => { req.destroy(new Error(`request timed out after ${TG_REQUEST_TIMEOUT_MS}ms`)); });
      req.on("error", (e) => {
        console.error(`[NOTIFY] Telegram send failed: ${e.message}`);
        _recordTgError(e.message);
        done();
      });
      req.write(body);
      req.end();
    });
  } catch (e) {
    console.error(`[NOTIFY] Telegram send threw: ${e.message}`);
    _recordTgError(e.message);
    return Promise.resolve();
  }
}

/**
 * Synchronous send via curl — blocks until HTTP completes.
 * Use from process-death handlers (uncaughtException, exit) where an async
 * https.request would be abandoned before the packet goes out. Requires `curl`
 * on PATH, which is standard on Linux servers. Bypasses toggles — crash
 * alerts should never be silenced.
 */
function sendTelegramSync(text) {
  if (!isConfigured()) return;
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  const escaped = text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
  const body = JSON.stringify({ chat_id: chatId, text: escaped, parse_mode: "MarkdownV2" });
  try {
    const r = spawnSync("curl", [
      "-s", "-m", "4",
      "-X", "POST",
      "-H", "Content-Type: application/json",
      "-d", body,
      `https://api.telegram.org/bot${token}/sendMessage`,
    ], { timeout: 5000, stdio: "ignore" });
    // curl exits non-zero on connection/timeout failure; record it so a blocked
    // Telegram is visible even when only crash/circuit alerts are firing. We
    // can't see the API body (stdio ignored), so this is a coarse failed/ok.
    if (r && (r.error || r.status !== 0)) _recordTgError(r.error ? r.error.message : `curl exit ${r.status}`);
    else if (r) _recordTgOk();
  } catch (_) { /* best-effort — never throw from a crash handler */ }
}

/**
 * pingTelegram() — active reachability probe via Telegram's getMe.
 * getMe is a read-only bot-info call: it validates the token and confirms the
 * API is reachable, but sends NO message to the chat (so it can run on every
 * dashboard health-modal open without spamming). During a network block it
 * times out exactly like a real send would. The result also refreshes the
 * passive health store (and thus the banner), so a probe doubles as a live
 * check. Returns a never-rejecting Promise of { configured, ok, code, error }.
 */
function pingTelegram() {
  if (!isConfigured()) return Promise.resolve({ configured: false, ok: false });
  try {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const options = {
      hostname: "api.telegram.org",
      path:     `/bot${token}/getMe`,
      method:   "GET",
      timeout:  TG_REQUEST_TIMEOUT_MS,
    };
    return new Promise((resolve) => {
      let settled = false;
      const done = (r) => { if (!settled) { settled = true; resolve(r); } };
      const req = https.request(options, (res) => {
        let raw = "";
        res.on("data", d => { raw += d; });
        res.on("end", () => {
          if (res.statusCode === 200) { _recordTgOk(); done({ configured: true, ok: true, code: 200 }); }
          else {
            const detail = raw.slice(0, 200);
            _recordTgError(`getMe HTTP ${res.statusCode}: ${detail}`, res.statusCode);
            done({ configured: true, ok: false, code: res.statusCode, error: detail });
          }
        });
        res.on("error", (e) => { _recordTgError(`getMe ${e.message}`); done({ configured: true, ok: false, error: e.message }); });
      });
      req.on("timeout", () => { req.destroy(new Error(`timed out after ${TG_REQUEST_TIMEOUT_MS}ms`)); });
      req.on("error", (e) => { _recordTgError(`getMe ${e.message}`); done({ configured: true, ok: false, error: e.message }); });
      req.end();
    });
  } catch (e) {
    _recordTgError(`getMe ${e.message}`);
    return Promise.resolve({ configured: true, ok: false, error: e.message });
  }
}

/**
 * Master-gated raw send. Obeys TG_ENABLED only (no per-event toggle).
 * Use for administrative/system messages that shouldn't be muted by per-event toggles.
 */
function sendIfMaster(text) {
  if (!isConfigured()) return;
  if (!isMasterEnabled()) return;
  sendTelegram(text);
}

// In-memory cooldown for system alerts. Map<key, lastSentMs>. Process-local — resets
// on restart. Used to prevent flooding Telegram if an upstream issue causes the same
// alert to fire repeatedly within a short window.
const _alertCooldowns = new Map(); // key -> { ts, cooldownMs }

function _shouldSendAlert(key, cooldownMs) {
  const now = Date.now();
  // Opportunistic eviction: once an entry's cooldown has elapsed it carries no
  // information (the next call would fire anyway), so drop it. Keeps the map
  // bounded to only currently-cooling keys instead of growing forever.
  for (const [k, e] of _alertCooldowns) {
    if (now - e.ts >= e.cooldownMs) _alertCooldowns.delete(k);
  }
  const e = _alertCooldowns.get(key);
  if (e && now - e.ts < cooldownMs) return false;
  _alertCooldowns.set(key, { ts: now, cooldownMs });
  return true;
}

/**
 * notifyAuthError({ broker, code, message })
 * Fires when a broker (Fyers/Zerodha) rejects auth (e.g. Fyers WS code -15 "invalid token").
 * Master-gated only — never silenced by per-mode toggles, since broken auth means trading
 * is dead. Cooldown of 30 min per broker so repeated reconnects don't flood the chat.
 */
function notifyAuthError({ broker, code, message }) {
  if (!isConfigured() || !isMasterEnabled()) return;
  const key = `auth:${(broker || "unknown").toLowerCase()}`;
  if (!_shouldSendAlert(key, 30 * 60_000)) return;
  const { date, time } = nowISTString();
  const lines = [
    `🚨 BROKER AUTH FAILURE — TRADING STOPPED`,
    ``,
    `Broker : ${broker || "—"}`,
    `Code   : ${code != null ? code : "—"}`,
    `Reason : ${message || "—"}`,
    ``,
    `📅 ${date}`,
    `🕐 ${time} IST`,
    ``,
    `Action required: re-login at /auth/login and restart any running session.`,
  ];
  sendTelegram(lines.join("\n"));
}

// ── Formatters ────────────────────────────────────────────────────────────────

function inr(n) {
  if (n == null) return "—";
  return "₹" + parseFloat(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function pnlArrow(pnl) {
  return pnl >= 0 ? "🟢 PROFIT" : "🔴 LOSS";
}

// Format a hold duration (ms) as "Xm Ys" / "Ys" — unambiguous clock time held,
// unlike the candle counter which reads 0 for a trade that opens and closes
// inside a single candle.
function fmtHeld(ms) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return null;
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const totalMin = Math.floor(totalSec / 60);
  if (totalMin < 60) return `${totalMin}m ${totalSec % 60}s`;
  const totalHr = Math.floor(totalMin / 60);
  if (totalHr < 24) return `${totalHr}h ${totalMin % 60}m`;
  return `${Math.floor(totalHr / 24)}d ${totalHr % 24}h`;
}

function modeLabel(mode) {
  if (!mode) return "";
  const m = String(mode).toUpperCase();
  if (m === "PAPER")        return "📄 SWING PAPER";
  if (m === "LIVE")         return "⚡ SWING LIVE";
  if (m === "SCALP-PAPER")  return "📄 SCALP PAPER";
  if (m === "SCALP-LIVE")   return "⚡ SCALP LIVE";
  if (m === "PA-PAPER")     return "📄 PA PAPER";
  if (m === "PA-LIVE")      return "⚡ PA LIVE";
  // ORB live modes may carry a " (DRY-RUN)" suffix — match by prefix
  // and preserve the suffix so the alert still shows the dry-run flag.
  if (m.startsWith("ORB-PAPER"))       return "📄 ORB PAPER" + m.slice("ORB-PAPER".length);
  if (m.startsWith("ORB-LIVE"))        return "⚡ ORB LIVE" + m.slice("ORB-LIVE".length);
  if (m.startsWith("EMA9VWAP-PAPER"))  return "📄 EMA9+VWAP PAPER" + m.slice("EMA9VWAP-PAPER".length);
  if (m.startsWith("EMA9VWAP-LIVE"))   return "⚡ EMA9+VWAP LIVE" + m.slice("EMA9VWAP-LIVE".length);
  return m;
}

function nowISTString() {
  const d = new Date();
  const date = d.toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", weekday: "short", day: "2-digit", month: "short", year: "numeric" });
  const time = d.toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" });
  return { date, time };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * notifyStarted({ mode, text })
 * Gated by TG_{group}_STARTED. Caller pre-composes `text`.
 */
function notifyStarted({ mode, text }) {
  const group = modeGroup(mode);
  if (!isModeEnabled(group)) return;
  if (!canSend(`TG_${group}_STARTED`)) return;
  sendTelegram(text);
}

// ── Live-order hooks ────────────────────────────────────────────────────────
// The live harness registers entry/exit hooks here so it can place real broker
// orders off the SAME notify call paper already makes. We invoke the hook from
// INSIDE notifyEntry/notifyExit (rather than reassigning the export) because
// paper modules destructure `const { notifyEntry } = require('./notify')` at
// load time — reassigning notify.notifyEntry would never reach those bindings,
// but the body of this stable function is always what they call.
// Keyed by harness id (e.g. "SWING-LIVE") so multiple harnesses can register
// concurrently. Each hook filters by its own mode, so they never collide —
// this is what lets all harnesses run in parallel.
const _orderHooks = new Map();   // id → { entry, exit }

/** Register live-order hooks under an id. Pass { entry, exit } (either may be null). */
function setOrderHooks(id, { entry = null, exit = null } = {}) {
  _orderHooks.set(id, { entry, exit });
}
/** Remove the live-order hooks registered under an id. */
function clearOrderHooks(id) {
  _orderHooks.delete(id);
}
function _fireEntryHooks(p) {
  for (const h of _orderHooks.values()) {
    if (h.entry) { try { h.entry(p); } catch (e) { console.error(`[notify] entry hook error: ${e.message}`); } }
  }
}
function _fireExitHooks(p) {
  for (const h of _orderHooks.values()) {
    if (h.exit) { try { h.exit(p); } catch (e) { console.error(`[notify] exit hook error: ${e.message}`); } }
  }
}

/**
 * notifyEntry({ mode, side, symbol, strike, expiry, spotAtEntry,
 *               optionEntryLtp, stopLoss, qty, reason })
 */
function notifyEntry(p) {
  // Fire the live-order hook FIRST — must run regardless of Telegram gating
  // (a mode with TG entry alerts disabled must still place its real order).
  _fireEntryHooks(p);

  const group = modeGroup(p.mode);
  if (!isModeEnabled(group)) return;
  if (!canSend(`TG_${group}_ENTRY`)) return;

  const sideEmoji = p.side === "CE" ? "📈 CALL (CE)" : "📉 PUT (PE)";
  const strikeStr = p.strike ? `Strike: ${p.strike}  |  Expiry: ${p.expiry || "—"}` : "";

  const lines = [
    `${modeLabel(p.mode)} — ENTRY`,
    ``,
    `${sideEmoji}`,
    `Symbol : ${p.symbol || "—"}`,
    strikeStr || null,
    ``,
    `Spot @ Entry   : ${inr(p.spotAtEntry)}`,
    `Option Premium : ${inr(p.optionEntryLtp)}`,
    `Stop Loss      : ${inr(p.stopLoss)}`,
    `Qty / Lots     : ${p.qty || "—"}`,
    ``,
    `Reason : ${p.reason || "—"}`,
  ].filter(l => l !== undefined && l !== null);

  sendTelegram(lines.join("\n"));
}

/**
 * notifyExit({ mode, side, symbol, strike, expiry,
 *              spotAtEntry, spotAtExit,
 *              optionEntryLtp, optionExitLtp,
 *              pnl, sessionPnl, exitReason, entryReason, entryTime, exitTime, qty,
 *              peakPremium, peakPnl, maxDrawdown, heldMs, candlesHeld })
 *
 * The trailing fields are optional diagnostics — each renders only when supplied,
 * so older call sites that pass none keep the original compact message.
 *   peakPremium  — highest option LTP reached during the trade (bestOptionLtp / peakPremium)
 *   peakPnl      — best unrealised P&L in ₹ (mfePnl / peakPnl)
 *   maxDrawdown  — worst unrealised P&L in ₹ (maePnl, negative)
 *   heldMs       — hold duration in ms (clock time); preferred over candlesHeld
 *   candlesHeld  — completed candles held; fallback when heldMs is absent
 */
function notifyExit(p) {
  // Fire the live-order hook FIRST — see notifyEntry note on Telegram gating.
  _fireExitHooks(p);

  const group = modeGroup(p.mode);
  if (!isModeEnabled(group)) return;
  if (!canSend(`TG_${group}_EXIT`)) return;

  const sideEmoji = p.side === "CE" ? "📈 CALL (CE)"
                  : p.side === "PE" ? "📉 PUT (PE)"
                  : `🎯 ${p.side || "—"}`;
  const pnlLine   = `PnL (net)      : ${inr(p.pnl)}  ${pnlArrow(p.pnl)}`;
  const strikeStr = p.strike ? `Strike: ${p.strike}  |  Expiry: ${p.expiry || "—"}` : "";

  // Optional "how the trade travelled" block — only the fields we were handed.
  const peakLines = [
    p.peakPremium != null ? `Peak Premium   : ${inr(p.peakPremium)}` : null,
    p.peakPnl     != null ? `Peak PnL       : ${inr(p.peakPnl)}`     : null,
    p.maxDrawdown != null ? `Max Drawdown   : ${inr(p.maxDrawdown)}` : null,
    fmtHeld(p.heldMs) != null
      ? `Held           : ${fmtHeld(p.heldMs)}`
      : (p.candlesHeld != null ? `Held           : ${p.candlesHeld} candle(s)` : null),
  ].filter(Boolean);

  const lines = [
    `${modeLabel(p.mode)} — EXIT`,
    ``,
    `${sideEmoji}`,
    `Symbol : ${p.symbol || "—"}`,
    strikeStr,
    ``,
    `Spot @ Entry   : ${inr(p.spotAtEntry)}`,
    `Spot @ Exit    : ${inr(p.spotAtExit)}`,
    `Premium @ Entry: ${inr(p.optionEntryLtp)}`,
    `Premium @ Exit : ${inr(p.optionExitLtp)}`,
    ``,
    pnlLine,
    `Session PnL    : ${inr(p.sessionPnl)}`,
    ...(peakLines.length ? [``, ...peakLines] : []),
    ``,
    `Entry Reason   : ${p.entryReason || "—"}`,
    `Exit Reason    : ${p.exitReason  || "—"}`,
    `Entry Time     : ${p.entryTime   || "—"}`,
    `Exit Time      : ${p.exitTime    || "—"}`,
  ].filter(l => l !== undefined);

  sendTelegram(lines.join("\n"));
}

/**
 * notifySignal({ mode, signal, reason, strength, spot, time })
 * Sent on candle close when flat — explains why a trade was or wasn't taken.
 */
function notifySignal({ mode, signal, reason, strength, spot, time }) {
  const group = modeGroup(mode);
  if (!isModeEnabled(group)) return;
  if (!canSend(`TG_${group}_SIGNALS`)) return;

  const lines = [
    `${modeLabel(mode)} — SIGNAL`,
    ``,
    `Signal   : ${signal || "NONE"}${strength ? ` [${strength}]` : ""}`,
    spot != null ? `Spot     : ${inr(spot)}` : null,
    time ? `Time     : ${time}` : null,
    ``,
    `Reason   : ${reason || "—"}`,
  ].filter(l => l !== null && l !== undefined);

  sendTelegram(lines.join("\n"));
}

/**
 * notifyDayReport({ mode, sessionTrades, sessionPnl, sessionStart, sessionEnd })
 * Fires per-mode when that mode's session stops. Gated by TG_{group}_DAYREPORT.
 */
function notifyDayReport({ mode, sessionTrades, sessionPnl, sessionStart, sessionEnd }) {
  const group = modeGroup(mode);
  if (!isModeEnabled(group)) return;
  if (!canSend(`TG_${group}_DAYREPORT`)) return;

  const list = Array.isArray(sessionTrades) ? sessionTrades : [];
  let count = list.length, wins = 0, losses = 0, grossPnl = 0;
  for (const t of list) {
    const pnl = Number(t.pnl) || 0;
    grossPnl += pnl;
    if (pnl > 0) wins++;
    else if (pnl < 0) losses++;
  }
  const totalPnl = (sessionPnl != null) ? Number(sessionPnl) : grossPnl;
  const winRate = count ? ((wins / count) * 100).toFixed(1) + "%" : "—";

  const { date, time } = nowISTString();
  const lines = [
    `${modeLabel(mode)} — DAY REPORT`,
    ``,
    `📅 ${date}`,
    `🕐 Ended ${time} IST`,
    sessionStart ? `Started  : ${new Date(sessionStart).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" })} IST` : null,
    ``,
    `Trades   : ${count}`,
    `Wins     : ${wins}`,
    `Losses   : ${losses}`,
    `Win rate : ${winRate}`,
    ``,
    `Net PnL  : ${inr(totalPnl)}  ${pnlArrow(totalPnl)}`,
  ].filter(l => l !== null);

  sendTelegram(lines.join("\n"));
}

/**
 * notifyConsolidatedDayReport({ byMode: { SWING, SCALP, PA, ORB } })
 * Fires once at market close (15:30 IST). Gated by TG_DAYREPORT_CONSOLIDATED.
 * Each byMode entry: { trades, wins, losses, pnl }
 * Returns true if a message was dispatched, false if gated off — the EOD
 * reporter uses this to only mark today as "sent" on an actual send (so a
 * restart catch-up keeps retrying until the report really goes out).
 */
function notifyConsolidatedDayReport({ byMode }) {
  if (!canSend("TG_DAYREPORT_CONSOLIDATED")) return false;

  // Only include strategies that are currently enabled in Settings.
  const groups = ["SWING", "SCALP", "PA", "ORB"].filter(isModeEnabled);
  let totalTrades = 0, totalPnl = 0, totalWins = 0, totalLosses = 0;
  const rows = [];

  for (const g of groups) {
    const b = (byMode && byMode[g]) || { trades: 0, wins: 0, losses: 0, pnl: 0 };
    const trades = Number(b.trades) || 0;
    const wins   = Number(b.wins)   || 0;
    const losses = Number(b.losses) || 0;
    const pnl    = Number(b.pnl)    || 0;
    totalTrades += trades;
    totalWins   += wins;
    totalLosses += losses;
    totalPnl    += pnl;
    rows.push(`${g.padEnd(8)} : ${String(trades).padStart(3)} trades | ${inr(pnl)}`);
  }

  const { date, time } = nowISTString();
  const winRate = totalTrades ? ((totalWins / totalTrades) * 100).toFixed(1) + "%" : "—";

  const lines = [
    `🧾 CONSOLIDATED DAY REPORT`,
    ``,
    `📅 ${date}`,
    `🕐 ${time} IST`,
    ``,
    ...rows,
    ``,
    `Total    : ${totalTrades} trades`,
    `Wins     : ${totalWins}`,
    `Losses   : ${totalLosses}`,
    `Win rate : ${winRate}`,
    ``,
    `Net PnL  : ${inr(totalPnl)}  ${pnlArrow(totalPnl)}`,
  ];

  sendTelegram(lines.join("\n"));
  return true;
}

module.exports = {
  isConfigured,
  getTelegramHealth,
  pingTelegram,
  sendTelegram,
  sendTelegramSync,
  sendIfMaster,
  canSend,
  modeGroup,
  isModeEnabled,
  notifyStarted,
  notifyEntry,
  notifyExit,
  notifySignal,
  notifyDayReport,
  notifyConsolidatedDayReport,
  notifyAuthError,
  setOrderHooks,
  clearOrderHooks,
};

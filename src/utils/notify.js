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
 *   TG_{SWING|SCALP|PA|ORB|STRADDLE}_STARTED    — session-start alerts (per mode)
 *   TG_{SWING|SCALP|PA|ORB|STRADDLE}_ENTRY      — trade entry alerts (per mode)
 *   TG_{SWING|SCALP|PA|ORB|STRADDLE}_EXIT       — trade exit alerts (per mode)
 *   TG_{SWING|SCALP|PA}_SIGNALS                 — candle-close skip/signal alerts (Swing/Scalp/PA only)
 *   TG_{SWING|SCALP|PA|ORB|STRADDLE}_DAYREPORT  — per-mode day report on session stop
 *   TG_DAYREPORT_CONSOLIDATED                   — one combined day report at market close
 *
 *   (ORB and Straddle emit no SIGNAL alerts, so they have no _SIGNALS toggle.)
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
  if (m === "STRADDLE" || m.startsWith("STRADDLE-") || m.startsWith("STRADDLE_")) return "STRADDLE";
  return "SWING";
}

/**
 * Straddle persists one record per leg (CE/PE) that share a `pairId` and a
 * combined `pairPnl`. Collapse legs to pairs so trade counts and win/loss
 * tallies reflect pair outcomes, not individual legs (a winning pair otherwise
 * shows as 1 win + 1 loss). Mirrors the pairing the Straddle history page does;
 * legs without a pairId are ignored, same as the page.
 */
function straddlePairStats(trades) {
  const seen = new Set();
  let count = 0, wins = 0, losses = 0, pnl = 0;
  for (const t of (Array.isArray(trades) ? trades : [])) {
    if (!t || !t.pairId || seen.has(t.pairId)) continue;
    seen.add(t.pairId);
    const p = Number(t.pairPnl) || 0;
    count++;
    pnl += p;
    if (p > 0) wins++;
    else if (p < 0) losses++;
  }
  return { count, wins, losses, pnl };
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

  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  let escaped;
  try {
    escaped = String(text).replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
  } catch (e) {
    console.error(`[NOTIFY] Telegram format failed: ${e.message}`);
    return Promise.resolve();
  }

  const body = JSON.stringify({
    chat_id:    chatId,
    text:       escaped,
    parse_mode: "MarkdownV2",
  });

  const options = {
    hostname: "api.telegram.org",
    path:     `/bot${token}/sendMessage`,
    method:   "POST",
    headers: {
      "Content-Type":   "application/json",
      "Content-Length": Buffer.byteLength(body),
    },
  };

  return new Promise((resolve) => {
    const req = https.request(options, (res) => {
      if (res.statusCode !== 200) {
        let raw = "";
        res.on("data", d => { raw += d; });
        res.on("end",  () => { console.error(`[NOTIFY] Telegram error ${res.statusCode}: ${raw.slice(0, 200)}`); resolve(); });
      } else {
        res.resume();
        res.on("end", resolve);
      }
    });
    req.on("error", (e) => { console.error(`[NOTIFY] Telegram send failed: ${e.message}`); resolve(); });
    req.write(body);
    req.end();
  });
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
    spawnSync("curl", [
      "-s", "-m", "4",
      "-X", "POST",
      "-H", "Content-Type: application/json",
      "-d", body,
      `https://api.telegram.org/bot${token}/sendMessage`,
    ], { timeout: 5000, stdio: "ignore" });
  } catch (_) { /* best-effort — never throw from a crash handler */ }
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
const _alertCooldowns = new Map();

function _shouldSendAlert(key, cooldownMs) {
  const last = _alertCooldowns.get(key) || 0;
  if (Date.now() - last < cooldownMs) return false;
  _alertCooldowns.set(key, Date.now());
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

function modeLabel(mode) {
  if (!mode) return "";
  const m = String(mode).toUpperCase();
  if (m === "PAPER")        return "📄 SWING PAPER";
  if (m === "LIVE")         return "⚡ SWING LIVE";
  if (m === "SCALP-PAPER")  return "📄 SCALP PAPER";
  if (m === "SCALP-LIVE")   return "⚡ SCALP LIVE";
  if (m === "PA-PAPER")     return "📄 PA PAPER";
  if (m === "PA-LIVE")      return "⚡ PA LIVE";
  // ORB / Straddle live modes may carry a " (DRY-RUN)" suffix — match by prefix
  // and preserve the suffix so the alert still shows the dry-run flag.
  if (m.startsWith("ORB-PAPER"))       return "📄 ORB PAPER" + m.slice("ORB-PAPER".length);
  if (m.startsWith("ORB-LIVE"))        return "⚡ ORB LIVE" + m.slice("ORB-LIVE".length);
  if (m.startsWith("STRADDLE-PAPER"))  return "📄 STRADDLE PAPER" + m.slice("STRADDLE-PAPER".length);
  if (m.startsWith("STRADDLE-LIVE"))   return "⚡ STRADDLE LIVE" + m.slice("STRADDLE-LIVE".length);
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

/**
 * notifyEntry({ mode, side, symbol, strike, expiry, spotAtEntry,
 *               optionEntryLtp, stopLoss, qty, reason })
 */
function notifyEntry(p) {
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
 *              pnl, sessionPnl, exitReason, entryTime, exitTime, qty })
 */
function notifyExit(p) {
  const group = modeGroup(p.mode);
  if (!isModeEnabled(group)) return;
  if (!canSend(`TG_${group}_EXIT`)) return;

  const sideEmoji = p.side === "CE" ? "📈 CALL (CE)" : "📉 PUT (PE)";
  const pnlLine   = `PnL (net)      : ${inr(p.pnl)}  ${pnlArrow(p.pnl)}`;
  const strikeStr = p.strike ? `Strike: ${p.strike}  |  Expiry: ${p.expiry || "—"}` : "";

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
    ``,
    `Exit Reason    : ${p.exitReason || "—"}`,
    `Entry Time     : ${p.entryTime  || "—"}`,
    `Exit Time      : ${p.exitTime   || "—"}`,
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
  let count, wins = 0, losses = 0, grossPnl = 0;
  if (group === "STRADDLE") {
    // Straddle records are per-leg; collapse to pairs so counts/win-rate are correct.
    ({ count, wins, losses, pnl: grossPnl } = straddlePairStats(list));
  } else {
    count = list.length;
    for (const t of list) {
      const pnl = Number(t.pnl) || 0;
      grossPnl += pnl;
      if (pnl > 0) wins++;
      else if (pnl < 0) losses++;
    }
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
 * notifyConsolidatedDayReport({ byMode: { SWING, SCALP, PA, ORB, STRADDLE } })
 * Fires once at market close (15:30 IST). Gated by TG_DAYREPORT_CONSOLIDATED.
 * Each byMode entry: { trades, wins, losses, pnl }
 */
function notifyConsolidatedDayReport({ byMode }) {
  if (!canSend("TG_DAYREPORT_CONSOLIDATED")) return;

  // Only include strategies that are currently enabled in Settings.
  const groups = ["SWING", "SCALP", "PA", "ORB", "STRADDLE"].filter(isModeEnabled);
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
}

module.exports = {
  isConfigured,
  sendTelegram,
  sendTelegramSync,
  sendIfMaster,
  canSend,
  modeGroup,
  isModeEnabled,
  straddlePairStats,
  notifyStarted,
  notifyEntry,
  notifyExit,
  notifySignal,
  notifyDayReport,
  notifyConsolidatedDayReport,
  notifyAuthError,
};

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
 * Toggle hierarchy (17 keys):
 *   TG_ENABLED                        — master gate; if false, nothing sends
 *   TG_{SWING|SCALP|PA}_STARTED       — session-start alerts (per mode)
 *   TG_{SWING|SCALP|PA}_ENTRY         — trade entry alerts (per mode)
 *   TG_{SWING|SCALP|PA}_EXIT          — trade exit alerts (per mode)
 *   TG_{SWING|SCALP|PA}_SIGNALS       — candle-close skip/signal alerts (per mode)
 *   TG_{SWING|SCALP|PA}_DAYREPORT     — per-mode day report on session stop
 *   TG_DAYREPORT_CONSOLIDATED         — one combined day report at market close
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

/** Map a mode string ("PAPER", "LIVE", "SCALP-PAPER", "PA-LIVE", ...) to group.
 *  The dash in "PA-" matters — plain "PAPER" would otherwise be misread as PA.
 */
function modeGroup(mode) {
  if (!mode) return "SWING";
  const m = String(mode).toUpperCase();
  if (m === "SCALP" || m.startsWith("SCALP-") || m.startsWith("SCALP_")) return "SCALP";
  if (m === "PA"    || m.startsWith("PA-")    || m.startsWith("PA_"))    return "PA";
  return "SWING";
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
  const key = `TG_${modeGroup(mode)}_STARTED`;
  if (!canSend(key)) return;
  sendTelegram(text);
}

/**
 * notifyEntry({ mode, side, symbol, strike, expiry, spotAtEntry,
 *               optionEntryLtp, stopLoss, qty, reason })
 */
function notifyEntry(p) {
  const key = `TG_${modeGroup(p.mode)}_ENTRY`;
  if (!canSend(key)) return;

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
  const key = `TG_${modeGroup(p.mode)}_EXIT`;
  if (!canSend(key)) return;

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
  const key = `TG_${modeGroup(mode)}_SIGNALS`;
  if (!canSend(key)) return;

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
  const key = `TG_${modeGroup(mode)}_DAYREPORT`;
  if (!canSend(key)) return;

  const trades = Array.isArray(sessionTrades) ? sessionTrades : [];
  let wins = 0, losses = 0, grossPnl = 0;
  for (const t of trades) {
    const pnl = Number(t.pnl) || 0;
    grossPnl += pnl;
    if (pnl > 0) wins++;
    else if (pnl < 0) losses++;
  }
  const totalPnl = (sessionPnl != null) ? Number(sessionPnl) : grossPnl;
  const winRate = trades.length ? ((wins / trades.length) * 100).toFixed(1) + "%" : "—";

  const { date, time } = nowISTString();
  const lines = [
    `${modeLabel(mode)} — DAY REPORT`,
    ``,
    `📅 ${date}`,
    `🕐 Ended ${time} IST`,
    sessionStart ? `Started  : ${new Date(sessionStart).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" })} IST` : null,
    ``,
    `Trades   : ${trades.length}`,
    `Wins     : ${wins}`,
    `Losses   : ${losses}`,
    `Win rate : ${winRate}`,
    ``,
    `Net PnL  : ${inr(totalPnl)}  ${pnlArrow(totalPnl)}`,
  ].filter(l => l !== null);

  sendTelegram(lines.join("\n"));
}

/**
 * notifyConsolidatedDayReport({ byMode: { SWING: {...}, SCALP: {...}, PA: {...} } })
 * Fires once at market close (15:30 IST). Gated by TG_DAYREPORT_CONSOLIDATED.
 * Each byMode entry: { trades, wins, losses, pnl }
 */
function notifyConsolidatedDayReport({ byMode }) {
  if (!canSend("TG_DAYREPORT_CONSOLIDATED")) return;

  const groups = ["SWING", "SCALP", "PA"];
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
    rows.push(`${g.padEnd(5)} : ${String(trades).padStart(3)} trades | ${inr(pnl)}`);
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

/**
 * Weekly per-mode trade report — last 7d vs prior 7d.
 * Input: byMode = { SWING: {last, prior}, SCALP: {...}, PA: {...} }
 *   where each window has { trades, wins, losses, avgWin, avgLoss, netPnl,
 *                           winRate, ratio }  (ratio = avgLoss/avgWin)
 * Flags any mode whose loss-to-win ratio worsened by ≥20% week-over-week.
 */
function notifyWeeklyTradeReport({ byMode }) {
  if (!canSend("TG_WEEKLY_REPORT")) return;

  const groups = ["SWING", "SCALP", "PA"];
  const { date, time } = nowISTString();
  const lines = [
    `📊 WEEKLY TRADE REPORT`,
    ``,
    `📅 ${date}`,
    `🕐 ${time} IST`,
    `Window: last 7d vs prior 7d`,
    ``,
  ];

  const flags = [];
  for (const g of groups) {
    const entry = (byMode && byMode[g]) || { last: null, prior: null };
    const last  = entry.last  || { trades: 0, wins: 0, losses: 0, avgWin: 0, avgLoss: 0, netPnl: 0, winRate: 0, ratio: null };
    const prior = entry.prior || { trades: 0, wins: 0, losses: 0, avgWin: 0, avgLoss: 0, netPnl: 0, winRate: 0, ratio: null };

    lines.push(`── ${g} ──`);
    if (last.trades === 0 && prior.trades === 0) {
      lines.push(`No trades in either window.`);
      lines.push(``);
      continue;
    }

    lines.push(`Trades   : ${last.trades}  (prev ${prior.trades})`);
    lines.push(`Net PnL  : ${inr(last.netPnl)}  (prev ${inr(prior.netPnl)}) ${pnlArrow(last.netPnl)}`);
    lines.push(`Win rate : ${last.winRate}%  (prev ${prior.winRate}%)`);
    lines.push(`Avg win  : ${inr(last.avgWin)}  (prev ${inr(prior.avgWin)})`);
    lines.push(`Avg loss : ${inr(last.avgLoss)}  (prev ${inr(prior.avgLoss)})`);

    const r = last.ratio !== null ? last.ratio.toFixed(2) : "—";
    const rPrev = prior.ratio !== null ? prior.ratio.toFixed(2) : "—";
    lines.push(`Loss/Win : ${r}x  (prev ${rPrev}x)  [lower is better]`);

    // Flag if ratio worsened ≥20% (or went from finite → unbounded with losses present).
    if (last.ratio !== null && prior.ratio !== null && prior.ratio > 0) {
      const delta = (last.ratio - prior.ratio) / prior.ratio;
      if (delta >= 0.20) {
        flags.push(`${g}: loss-to-win ratio worsened ${(delta * 100).toFixed(0)}% (${rPrev}x → ${r}x)`);
      }
    } else if (last.ratio === null && last.losses > 0) {
      flags.push(`${g}: zero winners this week with ${last.losses} losses`);
    }
    lines.push(``);
  }

  if (flags.length) {
    lines.push(`⚠️ Watch list:`);
    for (const f of flags) lines.push(`• ${f}`);
  } else {
    lines.push(`✅ No mode flagged this week.`);
  }

  sendTelegram(lines.join("\n"));
}

module.exports = {
  isConfigured,
  sendTelegram,
  sendTelegramSync,
  sendIfMaster,
  canSend,
  modeGroup,
  notifyStarted,
  notifyEntry,
  notifyExit,
  notifySignal,
  notifyDayReport,
  notifyConsolidatedDayReport,
  notifyWeeklyTradeReport,
};

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
 * If either env var is missing, all functions silently do nothing — no errors.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const https = require("https");

function isConfigured() {
  return !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);
}

/**
 * Send a plain text message to Telegram.
 * Uses MarkdownV2 — special chars are escaped automatically.
 */
function sendTelegram(text) {
  if (!isConfigured()) return;

  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  // Escape MarkdownV2 special characters
  const escaped = text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, "\\$1");

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

  const req = https.request(options, (res) => {
    // Silent — only log if it fails
    if (res.statusCode !== 200) {
      let raw = "";
      res.on("data", d => { raw += d; });
      res.on("end",  () => { console.error(`[NOTIFY] Telegram error ${res.statusCode}: ${raw.slice(0, 200)}`); });
    }
  });
  req.on("error", (e) => console.error(`[NOTIFY] Telegram send failed: ${e.message}`));
  req.write(body);
  req.end();
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
  if (mode === "PAPER") return "📄 PAPER TRADE";
  if (mode === "LIVE")  return "⚡ LIVE TRADE";
  return mode;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * notifyEntry({ mode, side, symbol, strike, expiry, spotAtEntry,
 *               optionEntryLtp, stopLoss, qty, reason })
 * mode: "PAPER" | "LIVE"
 */
function notifyEntry(p) {
  if (!isConfigured()) return;

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
  if (!isConfigured()) return;

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

module.exports = { notifyEntry, notifyExit, sendTelegram, isConfigured };

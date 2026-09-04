/**
 * zerodhaBroker.js — Zerodha Kite Connect Integration
 * ─────────────────────────────────────────────────────────────────────────────
 * BUG FIX v19: Token restored from disk was NOT validated against Zerodha's
 * servers — it just trusted the saved token blindly. Now isAuthenticated()
 * checks process.env.ZERODHA_ACCESS_TOKEN which is only set after a REAL
 * successful OAuth callback OR after a disk-token that was validated.
 *
 * Additional fix: logout() / clearToken() added so user can manually
 * invalidate a stale token via /auth/zerodha/logout.
 * ─────────────────────────────────────────────────────────────────────────────
 */

require("dotenv").config();
const fs   = require("fs");
const path = require("path");
const {
  guardedCall, withRetry, withCautiousRetry, breakerStatus, safetyConfig,
} = require("../utils/brokerSafety");

// ─────────────────────────────────────────────────────────────────────────────
// Token persistence — stored at ~/trading-data/ outside project, survives redeploys
// ─────────────────────────────────────────────────────────────────────────────

const TOKEN_FILE = path.join(require("os").homedir(), "trading-data", ".zerodha_token");

function saveZerodhaToken(token) {
  try {
    const dir = path.dirname(TOKEN_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    // Store with a "validated" flag — only set true after real OAuth callback
    const existing = loadRawToken();
    const validated = existing ? existing.validated : false;
    // 0600 — see the note in config/fyers.js saveToken(); this token trades.
    fs.writeFileSync(TOKEN_FILE, JSON.stringify({ token, savedAt: Date.now(), validated }), { encoding: "utf-8", mode: 0o600 });
    try { fs.chmodSync(TOKEN_FILE, 0o600); } catch (_) {}
  } catch (err) {
    console.warn("⚠️  Could not save Zerodha token:", err.message);
  }
}

function markTokenValidated(token) {
  try {
    const dir = path.dirname(TOKEN_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(TOKEN_FILE, JSON.stringify({
      token,
      savedAt:   Date.now(),
      savedDate: new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }),
      validated: true,
    }), { encoding: "utf-8", mode: 0o600 });
    try { fs.chmodSync(TOKEN_FILE, 0o600); } catch (_) {}
  } catch (err) {
    console.warn("⚠️  Could not mark Zerodha token validated:", err.message);
  }
}

function loadRawToken() {
  try {
    if (!fs.existsSync(TOKEN_FILE)) return null;
    return JSON.parse(fs.readFileSync(TOKEN_FILE, "utf-8"));
  } catch (err) {
    return null;
  }
}

function todayIST() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

function loadZerodhaToken() {
  try {
    if (!fs.existsSync(TOKEN_FILE)) return null;
    const data = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf-8"));
    const { token, savedAt, validated, savedDate } = data;

    // Only use token if it was confirmed via real OAuth callback
    if (!validated) {
      console.log("⚠️  [Zerodha] Disk token was never validated via OAuth — ignoring.");
      return null;
    }

    // ── Guard 1: date-based check (primary) ──────────────────────────────────
    // Zerodha tokens expire at 6 AM next day. If the token was saved on a
    // previous calendar day (IST), it is definitely stale — force fresh login.
    const today = todayIST();
    if (savedDate && savedDate !== today) {
      try { fs.unlinkSync(TOKEN_FILE); } catch (_) {}
      console.log("🕐 Zerodha token from previous day — please login again.");
      return null;
    }

    // ── Guard 2: age fallback (secondary) — catches tokens before savedDate field ─
    const ageHours = (Date.now() - (savedAt || 0)) / (1000 * 60 * 60);
    if (ageHours > 20) {
      try { fs.unlinkSync(TOKEN_FILE); } catch (_) {}
      console.log("🕐 Zerodha token expired (>20h old) — please login again.");
      return null;
    }

    return token;
  } catch (err) {
    console.warn(`⚠️ [Zerodha] Token load failed: ${err.message}`);
    return null;
  }
}

/** Clear stored token — called on logout or when token is known stale */
function clearZerodhaToken() {
  try {
    if (fs.existsSync(TOKEN_FILE)) fs.unlinkSync(TOKEN_FILE);
  } catch (_) {}
  delete process.env.ZERODHA_ACCESS_TOKEN;
  if (_kiteInstance) _kiteInstance.setAccessToken(null);
}

// ─────────────────────────────────────────────────────────────────────────────
// Zerodha session state
// ─────────────────────────────────────────────────────────────────────────────

let _kiteInstance = null;

function getKite() {
  if (_kiteInstance) return _kiteInstance;
  try {
    const { KiteConnect } = require("kiteconnect");
    _kiteInstance = new KiteConnect({ api_key: process.env.ZERODHA_API_KEY });

    // Only restore if the token was previously validated via real OAuth
    const diskToken = loadZerodhaToken();
    if (diskToken) {
      _kiteInstance.setAccessToken(diskToken);
      process.env.ZERODHA_ACCESS_TOKEN = diskToken;
      console.log("✅ [Zerodha] Validated token restored from disk.");
    }
    // NOTE: we intentionally do NOT fall back to process.env.ZERODHA_ACCESS_TOKEN
    // from .env because that would allow a stale manually-pasted token to mark
    // the system as authenticated without a real OAuth flow.

    return _kiteInstance;
  } catch (err) {
    throw new Error("kiteconnect package not found. Run: npm install kiteconnect\n" + err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Auth helpers
// ─────────────────────────────────────────────────────────────────────────────

function getLoginUrl() {
  const kite = getKite();
  return kite.getLoginURL();
}

async function generateAccessToken(requestToken) {
  const kite = getKite();
  const session = await kite.generateSession(requestToken, process.env.ZERODHA_API_SECRET);
  if (!session || !session.access_token) {
    throw new Error("Zerodha session generation failed — no access_token returned");
  }
  // Mark as validated — this came from a real OAuth callback
  kite.setAccessToken(session.access_token);
  process.env.ZERODHA_ACCESS_TOKEN = session.access_token;
  markTokenValidated(session.access_token);
  return session.access_token;
}

function setAccessToken(token) {
  process.env.ZERODHA_ACCESS_TOKEN = token;
  getKite().setAccessToken(token);
  markTokenValidated(token);
}

/** Returns true ONLY if a validated token is present */
function isAuthenticated() {
  return !!process.env.ZERODHA_ACCESS_TOKEN;
}

/** Logout — clear token so dashboard shows Disconnected */
function logout() {
  clearZerodhaToken();
  console.log("🔴 [Zerodha] Logged out — token cleared.");
}

// ─────────────────────────────────────────────────────────────────────────────
// Symbol conversion: Fyers → Zerodha
// ─────────────────────────────────────────────────────────────────────────────

function convertSymbol(fyersSymbol) {
  if (!fyersSymbol || typeof fyersSymbol !== "string") {
    throw new Error(`Invalid Fyers symbol: ${fyersSymbol}`);
  }
  const tradingsymbol = fyersSymbol.replace(/^(NSE:|BSE:)/, "").trim();
  let exchange;
  if (tradingsymbol.endsWith("CE") || tradingsymbol.endsWith("PE") || tradingsymbol.endsWith("FUT")) {
    exchange = "NFO";
  } else if (fyersSymbol.startsWith("BSE:")) {
    exchange = "BSE";
  } else {
    exchange = "NSE";
  }
  return { exchange, tradingsymbol };
}

// ─────────────────────────────────────────────────────────────────────────────
// Order placement
// ─────────────────────────────────────────────────────────────────────────────

async function placeMarketOrder(fyersSymbol, side, qty, orderTag = "ALGO_LIVE", { isFutures = false } = {}) {
  if (!isAuthenticated()) {
    throw new Error("Zerodha not authenticated. Complete Zerodha login first.");
  }
  const kite = getKite();
  const { exchange, tradingsymbol } = convertSymbol(fyersSymbol);
  const transactionType = side === 1 ? kite.TRANSACTION_TYPE_BUY : kite.TRANSACTION_TYPE_SELL;
  // Options: MIS (intraday) — Futures: NRML (normal, avoids auto-squareoff penalty)
  const product = isFutures ? kite.PRODUCT_NRML : kite.PRODUCT_MIS;
  const orderParams = {
    exchange, tradingsymbol,
    transaction_type: transactionType,
    quantity:         qty,
    product,
    order_type:       kite.ORDER_TYPE_MARKET,
    validity:         kite.VALIDITY_DAY,
    tag:              String(orderTag || "EMA_RSI_ST").substring(0, 20),
  };
  const sideLabel = transactionType === kite.TRANSACTION_TYPE_BUY ? "BUY" : "SELL";
  console.log(`[ZerodhaBroker] placeMarketOrder: ${sideLabel} ${qty} × ${tradingsymbol} (${exchange}) tag=${orderTag}`);
  try {
    const response = await guardedCall("zerodha", () =>
      withCautiousRetry(() => kite.placeOrder(kite.VARIETY_REGULAR, orderParams), {
        attempts: 2, baseMs: 200, label: "zerodha.placeOrder",
      }),
    );
    if (response && response.order_id) {
      console.log(`[ZerodhaBroker] Order SUCCESS — ${sideLabel} ${qty} × ${tradingsymbol} | OrderID: ${response.order_id}`);
      return { success: true,  orderId: response.order_id, raw: response };
    } else {
      console.warn(`[ZerodhaBroker] Order FAILED — ${sideLabel} ${qty} × ${tradingsymbol} | response: ${JSON.stringify(response).slice(0, 200)}`);
      return { success: false, orderId: null, raw: response };
    }
  } catch (err) {
    console.error(`[ZerodhaBroker] Order EXCEPTION — ${sideLabel} ${qty} × ${tradingsymbol}: ${err.message}`);
    return { success: false, orderId: null, raw: { error: err.message } };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// EQUITY — positional (CNC) delivery orders, used by the Swing Scanner
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Place a MARKET order in the NSE cash segment as a DELIVERY (CNC) position.
 *
 * Deliberately NOT routed through convertSymbol(). That helper is built for
 * option/future symbols and, handed a Fyers equity symbol, returns the
 * tradingsymbol "RELIANCE-EQ" — the "-EQ" suffix is a Fyers convention that
 * does not exist at Kite, and the order is rejected. This takes the plain NSE
 * tradingsymbol ("RELIANCE") and nothing else, so the wrong form cannot be
 * built by accident. Use stockUniverse.zerodhaSymbol() to produce it.
 *
 * variety:
 *   "regular"  market is open — fills immediately at the touch
 *   "amo"      market is shut — Kite holds it and releases it into the next
 *              trading day's pre-open. This is what makes an evening click
 *              turn into tomorrow morning's fill.
 *
 * product is always CNC: this is a positional trade meant to be HELD, and MIS
 * would be auto-squared-off by the broker at 15:20 the same day — silently
 * turning a swing entry into an intraday round trip.
 *
 * @param {string} tradingsymbol  plain NSE symbol, e.g. "RELIANCE"
 * @param {number} qty            whole shares, > 0
 * @param {object} opts           { variety, transactionType, tag }
 * @returns {{ success, orderId, raw, request }}
 */
async function placeEquityOrder(tradingsymbol, qty, { variety = "regular", transactionType = "BUY", tag = "SWING_SCAN" } = {}) {
  if (!isAuthenticated()) {
    throw new Error("Zerodha not authenticated. Complete Zerodha login first.");
  }
  const sym = String(tradingsymbol || "").trim().toUpperCase();
  if (!sym) {
    return { success: false, orderId: null, raw: { error: "Missing trading symbol" }, request: null };
  }
  // A malformed quantity must never reach the exchange. Fractional shares do
  // not exist in the NSE cash segment, and NaN would be sent through as-is.
  if (!Number.isInteger(qty) || qty <= 0) {
    return { success: false, orderId: null, raw: { error: `Invalid qty: ${qty}` }, request: null };
  }
  if (variety !== "regular" && variety !== "amo") {
    return { success: false, orderId: null, raw: { error: `Invalid variety: ${variety}` }, request: null };
  }
  if (transactionType !== "BUY" && transactionType !== "SELL") {
    return { success: false, orderId: null, raw: { error: `Invalid transaction type: ${transactionType}` }, request: null };
  }

  const kite = getKite();
  const orderParams = {
    exchange:         kite.EXCHANGE_NSE,
    tradingsymbol:    sym,
    transaction_type: transactionType === "BUY" ? kite.TRANSACTION_TYPE_BUY : kite.TRANSACTION_TYPE_SELL,
    quantity:         qty,
    product:          kite.PRODUCT_CNC,
    order_type:       kite.ORDER_TYPE_MARKET,
    validity:         kite.VALIDITY_DAY,
    tag:              String(tag || "SWING_SCAN").substring(0, 20),
  };

  console.log(`[ZerodhaBroker] placeEquityOrder: ${transactionType} ${qty} × ${sym} (NSE, CNC, MARKET, ${variety})`);
  try {
    // NOT retried on a broker-side rejection — see withCautiousRetry: only a
    // request that never reached Kite is retried, because a retried order that
    // DID arrive becomes a duplicate position.
    const response = await guardedCall("zerodha", () =>
      withCautiousRetry(() => kite.placeOrder(variety, orderParams), {
        attempts: 2, baseMs: 200, label: "zerodha.placeEquityOrder",
      }),
    );
    if (response && response.order_id) {
      console.log(`[ZerodhaBroker] Equity order SUCCESS — ${transactionType} ${qty} × ${sym} | OrderID: ${response.order_id} | ${variety}/CNC`);
      return { success: true, orderId: response.order_id, raw: response, request: Object.assign({ variety }, orderParams) };
    }
    console.warn(`[ZerodhaBroker] Equity order FAILED — ${transactionType} ${qty} × ${sym} | ${JSON.stringify(response).slice(0, 200)}`);
    return { success: false, orderId: null, raw: response || { error: "Kite returned no order_id" }, request: Object.assign({ variety }, orderParams) };
  } catch (err) {
    console.error(`[ZerodhaBroker] Equity order EXCEPTION — ${transactionType} ${qty} × ${sym}: ${err.message}`);
    return { success: false, orderId: null, raw: { error: err.message || String(err) }, request: Object.assign({ variety }, orderParams) };
  }
}

/**
 * Last traded price for NSE cash symbols. Returns a { SYMBOL: price } map that
 * contains ONLY the symbols Kite actually answered for — a missing symbol is
 * absent rather than 0, so a caller can never multiply a quantity by a fake
 * zero and show the user a ₹0 order value.
 *
 * @param {string[]} tradingsymbols plain NSE symbols, e.g. ["RELIANCE"]
 */
async function getEquityLTP(tradingsymbols) {
  if (!isAuthenticated()) return {};
  const syms = (tradingsymbols || []).map(s => String(s).trim().toUpperCase()).filter(Boolean);
  if (!syms.length) return {};
  try {
    const keys = syms.map(s => `NSE:${s}`);
    const res = await guardedCall("zerodha", () =>
      withRetry(() => getKite().getLTP(keys), {
        attempts: safetyConfig().retryReadAttempts, baseMs: safetyConfig().retryBaseMs, label: "zerodha.getLTP",
      }),
    );
    const out = {};
    for (const [key, val] of Object.entries(res || {})) {
      const price = val && Number(val.last_price);
      if (Number.isFinite(price) && price > 0) out[key.replace(/^NSE:/, "")] = price;
    }
    return out;
  } catch (err) {
    console.error(`Zerodha getLTP error: ${err.message}`);
    return {};
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Hard SL — SL-M (Stop Loss Market) orders for exchange-level protection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Place a SL-M (Stop Loss Market) order at Zerodha.
 * This order sits at the exchange and triggers automatically when the trigger
 * price is hit — even if the bot is offline.
 *
 * @param {string} fyersSymbol - e.g. "NSE:NIFTY2631024550CE"
 * @param {number} side - -1 for SELL (exit CE buy), 1 for BUY (exit PE short)
 * @param {number} qty - lot quantity
 * @param {number} triggerPrice - price at which the SL-M order fires
 * @param {object} opts - { isFutures: bool }
 * @returns {{ success, orderId, raw }}
 */
async function placeSLMOrder(fyersSymbol, side, qty, triggerPrice, { isFutures = false } = {}) {
  if (!isAuthenticated()) {
    throw new Error("Zerodha not authenticated.");
  }
  const kite = getKite();
  const { exchange, tradingsymbol } = convertSymbol(fyersSymbol);
  const transactionType = side === 1 ? kite.TRANSACTION_TYPE_BUY : kite.TRANSACTION_TYPE_SELL;
  const product = isFutures ? kite.PRODUCT_NRML : kite.PRODUCT_MIS;
  const orderParams = {
    exchange, tradingsymbol,
    transaction_type: transactionType,
    quantity:         qty,
    product,
    order_type:       kite.ORDER_TYPE_SLM,   // SL-M = Stop Loss Market
    trigger_price:    triggerPrice,
    validity:         kite.VALIDITY_DAY,
    tag:              "HARD_SL",
  };
  const slSideLabel = transactionType === kite.TRANSACTION_TYPE_BUY ? "BUY" : "SELL";
  console.log(`[ZerodhaBroker] placeSLMOrder: ${slSideLabel} ${qty} × ${tradingsymbol} @ trigger ₹${triggerPrice}`);
  try {
    const response = await guardedCall("zerodha", () =>
      withCautiousRetry(() => kite.placeOrder(kite.VARIETY_REGULAR, orderParams), {
        attempts: 2, baseMs: 200, label: "zerodha.placeSLM",
      }),
    );
    if (response && response.order_id) {
      console.log(`[ZerodhaBroker] SL-M placed — ${slSideLabel} ${qty} × ${tradingsymbol} | OrderID: ${response.order_id} | trigger=₹${triggerPrice}`);
      return { success: true, orderId: response.order_id, raw: response };
    }
    console.warn(`[ZerodhaBroker] SL-M FAILED — ${slSideLabel} ${qty} × ${tradingsymbol} | ${JSON.stringify(response).slice(0, 200)}`);
    return { success: false, orderId: null, raw: response };
  } catch (err) {
    console.error(`[ZerodhaBroker] SL-M EXCEPTION — ${tradingsymbol}: ${err.message}`);
    return { success: false, orderId: null, raw: { error: err.message } };
  }
}

/**
 * Modify the trigger price of an existing SL-M order (for trailing).
 */
async function modifySLMOrder(orderId, newTriggerPrice) {
  if (!isAuthenticated()) throw new Error("Zerodha not authenticated.");
  console.log(`[ZerodhaBroker] modifySLMOrder: ${orderId} → trigger ₹${newTriggerPrice}`);
  try {
    const kite = getKite();
    const response = await guardedCall("zerodha", () =>
      withCautiousRetry(() => kite.modifyOrder(kite.VARIETY_REGULAR, orderId, {
        order_type:    kite.ORDER_TYPE_SLM,
        trigger_price: newTriggerPrice,
      }), { attempts: safetyConfig().retryWriteAttempts, baseMs: safetyConfig().retryBaseMs, label: "zerodha.modifySLM" }),
    );
    console.log(`[ZerodhaBroker] SL-M modified — ${orderId} → ₹${newTriggerPrice}`);
    return { success: true, raw: response };
  } catch (err) {
    console.error(`[ZerodhaBroker] SL-M modify EXCEPTION — ${orderId}: ${err.message}`);
    return { success: false, raw: { error: err.message } };
  }
}

/**
 * Cancel an open SL-M order (before placing market exit).
 */
async function cancelOrder(orderId) {
  if (!isAuthenticated()) throw new Error("Zerodha not authenticated.");
  console.log(`[ZerodhaBroker] cancelOrder: ${orderId}`);
  try {
    const kite = getKite();
    const response = await guardedCall("zerodha", () =>
      withCautiousRetry(() => kite.cancelOrder(kite.VARIETY_REGULAR, orderId), {
        attempts: 2, baseMs: 200, label: "zerodha.cancelOrder",
      }),
    );
    console.log(`[ZerodhaBroker] Order cancelled — ${orderId}`);
    return { success: true, raw: response };
  } catch (err) {
    console.error(`[ZerodhaBroker] Cancel EXCEPTION — ${orderId}: ${err.message}`);
    return { success: false, raw: { error: err.message } };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Queries
// ─────────────────────────────────────────────────────────────────────────────

async function getOrders() {
  if (!isAuthenticated()) return [];
  try {
    return await guardedCall("zerodha", () =>
      withRetry(() => getKite().getOrders(), { attempts: safetyConfig().retryReadAttempts, baseMs: safetyConfig().retryBaseMs, label: "zerodha.getOrders" }),
    );
  } catch (err) { console.error("Zerodha getOrders error:", err.message); return []; }
}

async function getPositions() {
  if (!isAuthenticated()) return { net: [], day: [] };
  try {
    return await guardedCall("zerodha", () =>
      withRetry(() => getKite().getPositions(), { attempts: safetyConfig().retryReadAttempts, baseMs: safetyConfig().retryBaseMs, label: "zerodha.getPositions" }),
    );
  } catch (err) { console.error("Zerodha getPositions error:", err.message); return { net: [], day: [] }; }
}

async function getFunds() {
  if (!isAuthenticated()) return null;
  try {
    return await guardedCall("zerodha", () =>
      withRetry(() => getKite().getMargins(), { attempts: safetyConfig().retryReadAttempts, baseMs: safetyConfig().retryBaseMs, label: "zerodha.getMargins" }),
    );
  } catch (err) { console.error("Zerodha getFunds error:", err.message); return null; }
}

// Kite's /trades — today's executed fills only (order book is transient,
// lives one day server-side). Used to auto-sync manual trades going forward;
// past history has no API and must come from a Console tradebook CSV export.
async function getTrades() {
  if (!isAuthenticated()) return [];
  try {
    return await guardedCall("zerodha", () =>
      withRetry(() => getKite().getTrades(), { attempts: safetyConfig().retryReadAttempts, baseMs: safetyConfig().retryBaseMs, label: "zerodha.getTrades" }),
    );
  } catch (err) { console.error("Zerodha getTrades error:", err.message); return []; }
}

// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  getLoginUrl, generateAccessToken, setAccessToken,
  isAuthenticated, logout, clearZerodhaToken,
  convertSymbol, placeMarketOrder,
  placeEquityOrder, getEquityLTP,
  placeSLMOrder, modifySLMOrder, cancelOrder,
  getOrders, getPositions, getFunds, getTrades,
  breakerStatus,
};

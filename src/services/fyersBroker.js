/**
 * fyersBroker.js — Fyers Order Placement (Scalp Mode)
 * ─────────────────────────────────────────────────────────────────────────────
 * Uses the same Fyers SDK instance (fyersModel) that's already authenticated
 * for data feeds. Exposes order placement, position queries, and order management.
 *
 * Mirrors the zerodhaBroker.js interface so the scalp route can swap brokers easily.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const fyers = require("../config/fyers");

// ─────────────────────────────────────────────────────────────────────────────
// Auth helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Fyers is authenticated if ACCESS_TOKEN is set (shared with data feed) */
function isAuthenticated() {
  return !!process.env.ACCESS_TOKEN;
}

// ─────────────────────────────────────────────────────────────────────────────
// Order placement
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Place a market order via Fyers
 * @param {string} fyersSymbol - e.g. "NSE:NIFTY2631024550CE"
 * @param {number} side - 1=BUY, -1=SELL
 * @param {number} qty - quantity
 * @param {string} orderTag - optional tag for tracking
 * @param {object} opts - { isFutures: bool }
 * @returns {{ success, orderId, raw }}
 */
async function placeMarketOrder(fyersSymbol, side, qty, orderTag = "SCALP", { isFutures = false } = {}) {
  if (!isAuthenticated()) {
    throw new Error("Fyers not authenticated. Complete Fyers login first.");
  }

  // Fyers order params
  // productType: INTRADAY (auto square-off at EOD) for options scalp
  //              MARGIN for futures
  const orderParams = {
    symbol:        fyersSymbol,
    qty:           qty,
    type:          2,              // 2 = Market order
    side:          side === 1 ? 1 : -1,  // 1=BUY, -1=SELL
    productType:   isFutures ? "MARGIN" : "INTRADAY",
    limitPrice:    0,
    stopPrice:     0,
    validity:      "DAY",
    disclosedQty:  0,
    offlineOrder:  false,
    orderTag:      (orderTag || "SCALP").substring(0, 20),
  };

  try {
    const response = await fyers.place_order(orderParams);

    if (response && response.s === "ok" && response.id) {
      return { success: true, orderId: response.id, raw: response };
    } else {
      return {
        success: false,
        orderId: null,
        raw: response || { error: "Unknown response from Fyers" },
      };
    }
  } catch (err) {
    return {
      success: false,
      orderId: null,
      raw: { error: err.message || String(err) },
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Hard SL — SL-M orders for exchange-level protection
// ─────────────────────────────────────────────────────────────────────────────

async function placeSLMOrder(fyersSymbol, side, qty, triggerPrice, { isFutures = false } = {}) {
  if (!isAuthenticated()) throw new Error("Fyers not authenticated.");
  const orderParams = {
    symbol:        fyersSymbol,
    qty:           qty,
    type:          4,              // 4 = SL-M (Stop Loss Market) in Fyers API
    side:          side === 1 ? 1 : -1,
    productType:   isFutures ? "MARGIN" : "INTRADAY",
    limitPrice:    0,
    stopPrice:     triggerPrice,   // trigger price for SL-M
    validity:      "DAY",
    disclosedQty:  0,
    offlineOrder:  false,
    orderTag:      "HARD_SL",
  };
  try {
    const response = await fyers.place_order(orderParams);
    if (response && response.s === "ok" && response.id) {
      return { success: true, orderId: response.id, raw: response };
    }
    return { success: false, orderId: null, raw: response || { error: "Unknown" } };
  } catch (err) {
    return { success: false, orderId: null, raw: { error: err.message } };
  }
}

async function modifySLMOrder(orderId, newTriggerPrice) {
  if (!isAuthenticated()) throw new Error("Fyers not authenticated.");
  try {
    const response = await fyers.modify_order({
      id:         orderId,
      type:       4,         // SL-M (Stop Loss Market)
      stopPrice:  newTriggerPrice,
    });
    return { success: response && response.s === "ok", raw: response };
  } catch (err) {
    return { success: false, raw: { error: err.message } };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Queries
// ─────────────────────────────────────────────────────────────────────────────

async function getOrders() {
  if (!isAuthenticated()) return [];
  try {
    const response = await fyers.get_orders();
    if (response && response.s === "ok" && response.orderBook) {
      return response.orderBook;
    }
    return [];
  } catch (err) {
    console.error("Fyers getOrders error:", err.message);
    return [];
  }
}

async function getPositions() {
  if (!isAuthenticated()) return { netPositions: [] };
  try {
    const response = await fyers.get_positions();
    if (response && response.s === "ok" && response.netPositions) {
      return { netPositions: response.netPositions };
    }
    return { netPositions: [] };
  } catch (err) {
    console.error("Fyers getPositions error:", err.message);
    return { netPositions: [] };
  }
}

async function cancelOrder(orderId) {
  if (!isAuthenticated()) throw new Error("Fyers not authenticated");
  try {
    const response = await fyers.cancel_order({ id: orderId });
    return { success: response && response.s === "ok", raw: response };
  } catch (err) {
    return { success: false, raw: { error: err.message } };
  }
}

async function exitPosition(symbol) {
  if (!isAuthenticated()) throw new Error("Fyers not authenticated");
  try {
    const response = await fyers.exit_position({ id: symbol });
    return { success: response && response.s === "ok", raw: response };
  } catch (err) {
    return { success: false, raw: { error: err.message } };
  }
}

// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  isAuthenticated,
  placeMarketOrder,
  placeSLMOrder,
  modifySLMOrder,
  getOrders,
  getPositions,
  cancelOrder,
  exitPosition,
};

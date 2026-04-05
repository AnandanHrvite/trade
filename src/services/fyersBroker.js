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

  const sideLabel = side === 1 ? "BUY" : "SELL";
  console.log(`[FyersBroker] placeMarketOrder: ${sideLabel} ${qty} × ${fyersSymbol} (${orderTag})`);
  try {
    const response = await fyers.place_order(orderParams);

    if (response && response.s === "ok" && response.id) {
      console.log(`[FyersBroker] Order SUCCESS — ${sideLabel} ${qty} × ${fyersSymbol} | OrderID: ${response.id}`);
      return { success: true, orderId: response.id, raw: response };
    } else {
      console.warn(`[FyersBroker] Order FAILED — ${sideLabel} ${qty} × ${fyersSymbol} | response: ${JSON.stringify(response).slice(0, 200)}`);
      return {
        success: false,
        orderId: null,
        raw: response || { error: "Unknown response from Fyers" },
      };
    }
  } catch (err) {
    console.error(`[FyersBroker] Order EXCEPTION — ${sideLabel} ${qty} × ${fyersSymbol}: ${err.message}`);
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
  const sideLabel = side === 1 ? "BUY" : "SELL";
  console.log(`[FyersBroker] placeSLMOrder: ${sideLabel} ${qty} × ${fyersSymbol} @ trigger ₹${triggerPrice}`);
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
      console.log(`[FyersBroker] SL-M placed — ${sideLabel} ${qty} × ${fyersSymbol} | OrderID: ${response.id} | trigger=₹${triggerPrice}`);
      return { success: true, orderId: response.id, raw: response };
    }
    console.warn(`[FyersBroker] SL-M FAILED — ${sideLabel} ${qty} × ${fyersSymbol} | ${JSON.stringify(response).slice(0, 200)}`);
    return { success: false, orderId: null, raw: response || { error: "Unknown" } };
  } catch (err) {
    console.error(`[FyersBroker] SL-M EXCEPTION — ${fyersSymbol}: ${err.message}`);
    return { success: false, orderId: null, raw: { error: err.message } };
  }
}

async function modifySLMOrder(orderId, newTriggerPrice) {
  if (!isAuthenticated()) throw new Error("Fyers not authenticated.");
  console.log(`[FyersBroker] modifySLMOrder: ${orderId} → trigger ₹${newTriggerPrice}`);
  try {
    const response = await fyers.modify_order({
      id:         orderId,
      type:       4,         // SL-M (Stop Loss Market)
      stopPrice:  newTriggerPrice,
    });
    const ok = response && response.s === "ok";
    if (ok) console.log(`[FyersBroker] SL-M modified — ${orderId} → ₹${newTriggerPrice}`);
    else console.warn(`[FyersBroker] SL-M modify FAILED — ${orderId} | ${JSON.stringify(response).slice(0, 200)}`);
    return { success: ok, raw: response };
  } catch (err) {
    console.error(`[FyersBroker] SL-M modify EXCEPTION — ${orderId}: ${err.message}`);
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
  console.log(`[FyersBroker] cancelOrder: ${orderId}`);
  try {
    const response = await fyers.cancel_order({ id: orderId });
    const ok = response && response.s === "ok";
    if (ok) console.log(`[FyersBroker] Order cancelled — ${orderId}`);
    else console.warn(`[FyersBroker] Cancel FAILED — ${orderId} | ${JSON.stringify(response).slice(0, 200)}`);
    return { success: ok, raw: response };
  } catch (err) {
    console.error(`[FyersBroker] Cancel EXCEPTION — ${orderId}: ${err.message}`);
    return { success: false, raw: { error: err.message } };
  }
}

async function exitPosition(symbol) {
  if (!isAuthenticated()) throw new Error("Fyers not authenticated");
  console.log(`[FyersBroker] exitPosition: ${symbol}`);
  try {
    const response = await fyers.exit_position({ id: symbol });
    const ok = response && response.s === "ok";
    if (ok) console.log(`[FyersBroker] Position exited — ${symbol}`);
    else console.warn(`[FyersBroker] Exit FAILED — ${symbol} | ${JSON.stringify(response).slice(0, 200)}`);
    return { success: ok, raw: response };
  } catch (err) {
    console.error(`[FyersBroker] Exit EXCEPTION — ${symbol}: ${err.message}`);
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

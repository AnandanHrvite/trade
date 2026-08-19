/**
 * swingScanner.js — SWING SCANNER (stock screen + manual positional entry)
 * ─────────────────────────────────────────────────────────────────────────────
 *   GET  /swing-scanner                → the page
 *   GET  /swing-scanner/meta           → dropdown contents + broker/market state
 *   GET  /swing-scanner/scan           → start (or re-attach to) a scan job
 *   GET  /swing-scanner/scan/status    → poll a scan job
 *   GET  /swing-scanner/scan/cancel    → stop a running scan
 *   GET  /swing-scanner/quote          → live LTP for the order popup
 *   POST /swing-scanner/order          → place the order  ⟵ API_SECRET required
 *
 * WHAT THIS PAGE IS
 * ─────────────────
 * Pick one of your ACTIVE strategies, pick a timeframe, pick a universe, press
 * Search: every stock in that universe is run through that strategy's own
 * signal code on that timeframe, and the ones that fire come back ranked. Each
 * row has a Buy button that places a REAL positional (CNC) order at Zerodha.
 *
 * The scan is read-only and idempotent. The Buy button is not — see below.
 *
 * WHAT THIS PAGE IS NOT
 * ─────────────────────
 * It is not an engine. It holds no position, runs no session, takes no socket,
 * and is not wired into sharedSocketState / positionPersist / capitalPool. It
 * never places an order on its own and it never exits one. Everything it does
 * happens because someone clicked. Anything you buy here is YOURS to manage —
 * the stop shown in a row is the strategy's suggestion, and nothing in this
 * process will act on it. That is the single most important thing to know
 * about this page, so it is also stated on the page itself.
 *
 * THE TIMEFRAME IS LOCAL TO THIS PAGE
 * ───────────────────────────────────
 * The timeframe dropdown does NOT read or write TRADE_RESOLUTION or any other
 * Settings key. Changing it changes this scan and nothing else — no running
 * strategy sees it. That is deliberate: this is a research surface and it must
 * not be able to reconfigure a live engine as a side effect of a dropdown.
 *
 * ORDER SAFETY
 * ────────────
 * Orders here are REAL — there is no dry-run gate, by the operator's explicit
 * decision. What stands in their place:
 *
 *   • the popup states the exact order (symbol, qty, value, regular vs AMO) and
 *     needs a second, separate confirmation click before anything is sent;
 *   • API_SECRET is required on the POST, so the page alone is not enough;
 *   • a fat-finger ceiling on ORDER VALUE (SWING_SCANNER_MAX_ORDER_VALUE,
 *     default ₹10,00,000) rejects an order worth more than that. It is a typo
 *     guard, not a permission gate — raise it in Settings when you mean to;
 *   • the server never trusts the browser's price. It re-fetches the LTP and
 *     re-derives regular-vs-AMO at order time. A stale tab cannot place an
 *     order priced off a number that has since moved;
 *   • every attempt — accepted, rejected or refused — is appended to
 *     ~/trading-data/trades/swing_scanner_orders_YYYY-MM-DD.jsonl before the
 *     user is told anything, so the audit trail cannot be lost to a crash
 *     between the broker call and the response.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const express = require("express");
const fs      = require("fs");
const path    = require("path");
const os      = require("os");
const router  = express.Router();

const scanner    = require("../services/swingScanner");
const adapters   = require("../services/swingStrategyAdapters");
const stockUniverse = require("../utils/stockUniverse");
const zerodha    = require("../services/zerodhaBroker");
const notify     = require("../utils/notify");
const { resolveTheme } = require("../utils/theme");
const {
  buildSidebar, sidebarCSS, faviconLink, modalCSS, modalJS, toastJS,
} = require("../utils/sharedNav");

const ORDER_LOG_DIR = path.join(os.homedir(), "trading-data", "trades");

// ─────────────────────────────────────────────────────────────────────────────
// Order audit log
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Append one order attempt to today's JSONL. Called BEFORE the caller responds,
 * including for refusals — a rejected order is exactly the record you want when
 * working out later why a position is missing. Never throws: a disk problem
 * must not turn a placed order into a 500 the user reads as "it did not go".
 */
function logOrderAttempt(record) {
  try {
    if (!fs.existsSync(ORDER_LOG_DIR)) fs.mkdirSync(ORDER_LOG_DIR, { recursive: true });
    const day  = scanner.istDateStr(Math.floor(Date.now() / 1000));
    const file = path.join(ORDER_LOG_DIR, `swing_scanner_orders_${day}.jsonl`);
    fs.appendFileSync(file, JSON.stringify(Object.assign({ ts: new Date().toISOString() }, record)) + "\n");
  } catch (err) {
    console.error(`[swingScanner] order log write failed: ${err.message}`);
  }
}

function maxOrderValue() {
  const v = parseFloat(process.env.SWING_SCANNER_MAX_ORDER_VALUE || "1000000");
  return Number.isFinite(v) && v > 0 ? v : 1000000;
}

function inr(n) {
  return "₹" + Number(n || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 });
}

// ─────────────────────────────────────────────────────────────────────────────
// JSON endpoints
// ─────────────────────────────────────────────────────────────────────────────

/** Everything the three dropdowns need, plus the state the page must warn about. */
router.get("/meta", (req, res) => {
  const active = adapters.activeAdapters();
  const { universes, error: universeError } = stockUniverse.listUniverses();
  const plan = scanner.orderPlan();
  res.json({
    success: true,
    strategies: active.map(a => ({
      key: a.key, label: a.label, blurb: a.blurb,
      timeframes: a.timeframes, timeframeNote: a.timeframeNote || null,
      needsDaily: !!a.needsDaily,
    })),
    timeframes: scanner.listTimeframes().map(t => ({ key: t.key, label: t.label })),
    universes,
    universeError,
    universeFile: stockUniverse.OVERRIDE_FILE,
    market: { open: scanner.withinMarketHours(), plan },
    brokers: {
      fyers:   { authenticated: !!process.env.ACCESS_TOKEN },
      zerodha: { authenticated: zerodha.isAuthenticated() },
    },
    limits: { maxOrderValue: maxOrderValue() },
    scaling: { enabled: adapters.scalingOn(), niftyRef: adapters.niftyRef() },
  });
});

/** Start a scan, or re-attach to the identical one already running. */
router.get("/scan", (req, res) => {
  const { strategy, timeframe, universe } = req.query;
  if (!process.env.ACCESS_TOKEN) {
    return res.status(400).json({
      success: false,
      error: "Fyers is not logged in — the scanner reads its candles from Fyers. Log in from the sidebar, then search again.",
    });
  }
  try {
    const { job, reused } = scanner.startScan({ strategy, timeframe, universe });
    res.json({ success: true, reused, job: scanner.jobView(job) });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.get("/scan/status", (req, res) => {
  const job = scanner.getJob(req.query.id);
  if (!job) return res.status(404).json({ success: false, error: "That scan is no longer in memory — run it again." });
  res.json({ success: true, job: scanner.jobView(job) });
});

// A GET that mutates, deliberately kept open like /scan itself: its only effect
// is to STOP a read-only scan that the same open endpoint could have started.
router.get("/scan/cancel", (req, res) => {
  const ok = scanner.cancelJob(req.query.id);
  res.json({ success: true, cancelled: ok });
});

/**
 * LTP for the order popup. Zerodha is asked first because that is the venue the
 * order goes to; the scan's own last close is the fallback so the popup still
 * works before a Zerodha login. The source is always reported — the user must
 * be able to see when a price is a stale candle close rather than a live quote.
 */
router.get("/quote", async (req, res) => {
  const symbol = String(req.query.symbol || "").trim().toUpperCase();
  if (!symbol) return res.status(400).json({ success: false, error: "symbol is required" });
  const fallback = parseFloat(req.query.fallback);

  // The order plan rides along with the quote, re-derived NOW. The page computes
  // it once at load; a tab left open from before the open would otherwise offer
  // to place an AMO while the server was about to send a regular order — the
  // popup would be telling the user something the server had already stopped
  // believing. The server's decision at order time is still the authority; this
  // just keeps what the user is shown in step with it.
  const plan = scanner.orderPlan();

  if (zerodha.isAuthenticated()) {
    const map = await zerodha.getEquityLTP([symbol]);
    if (map[symbol]) {
      return res.json({ success: true, symbol, ltp: map[symbol], source: "zerodha", live: true, plan, marketOpen: scanner.withinMarketHours() });
    }
  }
  if (Number.isFinite(fallback) && fallback > 0) {
    return res.json({
      success: true, symbol, ltp: fallback, source: "scan", live: false, plan, marketOpen: scanner.withinMarketHours(),
      note: zerodha.isAuthenticated()
        ? "Zerodha did not quote this symbol — showing the last candle close from the scan."
        : "Zerodha is not logged in — showing the last candle close from the scan.",
    });
  }
  res.status(502).json({ success: false, error: "No price available for this symbol." });
});

/**
 * Place the order. Everything that decides what is sent is recomputed here —
 * the browser supplies only the symbol and the quantity.
 */
router.post("/order", async (req, res) => {
  const body   = req.body || {};
  const symbol = String(body.symbol || "").trim().toUpperCase();
  const qty    = Number(body.qty);
  const strategy = String(body.strategy || "").slice(0, 24);
  const timeframe = String(body.timeframe || "").slice(0, 8);

  const refuse = (error, extra = {}) => {
    logOrderAttempt(Object.assign({ event: "refused", symbol, qty, strategy, timeframe, error }, extra));
    return res.status(400).json({ success: false, error });
  };

  if (!symbol)                                return refuse("No symbol given.");
  if (!Number.isInteger(qty) || qty <= 0)     return refuse(`Quantity must be a whole number of shares above zero (got "${body.qty}").`);
  if (!zerodha.isAuthenticated())             return refuse("Zerodha is not logged in — orders go to Zerodha, so log in from the sidebar first.");

  // Price: live from Zerodha, or the client's scan close as a last resort. Only
  // used for the value ceiling and the record — this is a MARKET order, so the
  // fill price is whatever the exchange gives.
  let price = null, priceSource = "none";
  const map = await zerodha.getEquityLTP([symbol]);
  if (map[symbol]) { price = map[symbol]; priceSource = "zerodha"; }
  else if (Number.isFinite(Number(body.ltp)) && Number(body.ltp) > 0) { price = Number(body.ltp); priceSource = "scan"; }

  if (price == null) {
    return refuse(`Zerodha would not quote ${symbol}, and no fallback price was supplied — refusing to send an order whose value cannot be checked.`);
  }

  const value = qty * price;
  const cap   = maxOrderValue();
  if (value > cap) {
    return refuse(
      `That order is worth about ${inr(value)} (${qty} × ${inr(price)}), over the ${inr(cap)} per-order ceiling. ` +
      `If you meant it, raise "Max order value" in Settings → Swing Scanner.`,
      { value, cap, price, priceSource },
    );
  }

  const plan    = scanner.orderPlan();
  const charges = scanner.equityBuyCharges(qty, price);

  logOrderAttempt({
    event: "submitting", symbol, qty, strategy, timeframe,
    price, priceSource, value, variety: plan.variety, product: "CNC", orderType: "MARKET",
  });

  let result;
  try {
    result = await zerodha.placeEquityOrder(symbol, qty, {
      variety: plan.variety, transactionType: "BUY", tag: "SWING_SCAN",
    });
  } catch (err) {
    logOrderAttempt({ event: "exception", symbol, qty, strategy, timeframe, error: err.message });
    return res.status(502).json({ success: false, error: `Zerodha rejected the order: ${err.message}` });
  }

  logOrderAttempt({
    event: result.success ? "placed" : "rejected",
    symbol, qty, strategy, timeframe, price, priceSource, value,
    variety: plan.variety, orderId: result.orderId || null,
    charges: charges.total, broker: result.raw,
  });

  if (result.success) {
    try {
      notify.sendIfMaster(
        `🟢 SWING SCANNER — order placed\n` +
        `${symbol} · BUY ${qty} @ MARKET (CNC${plan.isAmo ? " · AMO" : ""})\n` +
        `≈ ${inr(value)} + ${inr(charges.total)} charges\n` +
        `Strategy: ${strategy || "—"} ${timeframe ? `· ${timeframe}` : ""}\n` +
        `Order ID: ${result.orderId}\n` +
        `⚠️ No engine manages this position — the exit is yours.`,
      );
    } catch (_) { /* Telegram must never fail an order response */ }

    return res.json({
      success: true, orderId: result.orderId, symbol, qty,
      variety: plan.variety, isAmo: plan.isAmo, product: "CNC", orderType: "MARKET",
      price, priceSource, value, charges,
      message: plan.isAmo
        ? `AMO placed — Zerodha will release it into the next trading day's open.`
        : `Order placed at market.`,
    });
  }

  const brokerMsg = (result.raw && (result.raw.message || result.raw.error)) || "Zerodha did not return an order id.";
  return res.status(502).json({ success: false, error: brokerMsg, broker: result.raw });
});

// ─────────────────────────────────────────────────────────────────────────────
// Page
// ─────────────────────────────────────────────────────────────────────────────

router.get("/", (req, res) => {
  const theme = resolveTheme();
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  ${faviconLink()}
  <title>Swing Scanner — Trading BOT</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet"/>
  <script>(function(){ if ('${theme}' === 'light') document.documentElement.setAttribute('data-theme','light'); })();</script>
  <style>
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
    body{font-family:'Inter',sans-serif;background:#040c18;color:#e0eaf8;overflow-x:hidden;}
    ${sidebarCSS()}
    ${modalCSS()}

    .page{padding:20px 22px 70px;}
    .hd{display:flex;align-items:flex-start;gap:12px;flex-wrap:wrap;margin-bottom:4px;}
    .hd h1{font-size:1.25rem;font-weight:700;letter-spacing:-0.3px;}
    .pill{font-family:'IBM Plex Mono',monospace;font-size:0.58rem;font-weight:700;letter-spacing:1px;
          text-transform:uppercase;padding:4px 9px;border-radius:20px;border:1px solid;white-space:nowrap;}
    .pill.ok{background:#04241a;border-color:#0e5a3c;color:#34d399;}
    .pill.warn{background:#241a04;border-color:#5a430e;color:#fbbf24;}
    .pill.bad{background:#240a0a;border-color:#5a1010;color:#f87171;}
    .pill.info{background:#0a1a2e;border-color:#12385e;color:#60a5fa;}
    .sub{font-size:0.74rem;color:var(--muted-1,#8ba1c2);line-height:1.6;margin-bottom:14px;max-width:900px;}
    .sub b{color:#bcd2f0;font-weight:600;}

    .warnbar{background:#241a04;border:1px solid #5a430e;color:#fbbf24;font-size:0.72rem;line-height:1.55;
             padding:10px 13px;border-radius:8px;margin-bottom:14px;}
    .warnbar.err{background:#240a0a;border-color:#5a1010;color:#f87171;}
    .warnbar b{font-weight:700;}
    .warnbar a{color:inherit;font-weight:700;}

    /* ── Search bar ── */
    .ctl{background:#07111f;border:0.5px solid #0e1e36;border-radius:12px;padding:14px 16px;margin-bottom:14px;}
    .ctl-grid{display:grid;grid-template-columns:1.4fr 1fr 1.2fr auto;gap:12px;align-items:end;}
    .fld{display:flex;flex-direction:column;gap:5px;min-width:0;}
    .fld label{font-size:0.56rem;text-transform:uppercase;letter-spacing:1.1px;color:var(--muted-2,#6d85a8);
               font-family:'IBM Plex Mono',monospace;font-weight:600;}
    select,input{background:#04090f;border:0.5px solid #0e1e36;color:#e0eaf8;padding:9px 11px;border-radius:8px;
                 font-family:'IBM Plex Mono',monospace;font-size:0.78rem;outline:none;width:100%;min-height:38px;}
    select:focus,input:focus{border-color:#38bdf8;}
    select option:disabled{color:#3a4a60;}
    .btn{background:#0c4a6e;border:0.5px solid #1e5a80;color:#7dd3fc;padding:9px 20px;border-radius:8px;
         font-family:'IBM Plex Mono',monospace;font-size:0.78rem;font-weight:700;cursor:pointer;min-height:38px;white-space:nowrap;}
    .btn:hover:not(:disabled){background:#0e5a84;}
    .btn:disabled{opacity:0.45;cursor:not-allowed;}
    .btn.ghost{background:transparent;border-color:#1a2a40;color:var(--muted-1,#8ba1c2);}
    .btn.ghost:hover:not(:disabled){border-color:#3a5070;color:#a0c0e0;background:transparent;}
    .btn.buy{background:#065f46;border-color:#0a7a5a;color:#6ee7b7;padding:6px 14px;font-size:0.68rem;min-height:30px;}
    .btn.buy:hover:not(:disabled){background:#047857;}
    .hint{font-size:0.64rem;color:var(--muted-2,#6d85a8);margin-top:8px;line-height:1.5;}

    /* ── Progress ── */
    .prog{margin-top:12px;display:none;}
    .prog.on{display:block;}
    .prog-bar{height:5px;background:#0a1526;border-radius:3px;overflow:hidden;}
    .prog-fill{height:100%;background:linear-gradient(90deg,#0ea5e9,#38bdf8);width:0%;transition:width 0.3s;}
    .prog-txt{font-family:'IBM Plex Mono',monospace;font-size:0.66rem;color:var(--muted-1,#8ba1c2);margin-top:6px;
              display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;}

    /* ── Stats ── */
    .stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:9px;margin-bottom:14px;}
    .st{background:#07111f;border:0.5px solid #0e1e36;border-radius:9px;padding:10px 13px;}
    .st .k{font-size:0.54rem;text-transform:uppercase;letter-spacing:1.1px;color:var(--muted-2,#6d85a8);margin-bottom:4px;
           font-family:'IBM Plex Mono',monospace;}
    .st .v{font-size:1.05rem;font-weight:700;font-family:'IBM Plex Mono',monospace;}
    .v.long{color:#34d399;} .v.short{color:#f87171;} .v.dim{color:var(--muted-1,#8ba1c2);}

    /* ── Filters ── */
    .filt{background:#07111f;border:0.5px solid #0e1e36;border-radius:12px;padding:12px 14px;margin-bottom:14px;display:none;}
    .filt.on{display:block;}
    .filt-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(135px,1fr));gap:10px;align-items:end;}
    .filt-foot{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-top:10px;flex-wrap:wrap;}
    .cnt{font-family:'IBM Plex Mono',monospace;font-size:0.68rem;color:var(--muted-1,#8ba1c2);}

    /* ── Results: a grid that becomes cards on a phone ── */
    .tbl{background:#07111f;border:0.5px solid #0e1e36;border-radius:12px;overflow:hidden;}
    .cols{display:grid;grid-template-columns:
          minmax(96px,1.2fr) 72px 92px 74px 66px 92px 70px 78px 62px 74px minmax(150px,2fr) 86px;
          gap:0;align-items:center;}
    .thead{background:#0a1526;border-bottom:1px solid #0e1e36;position:sticky;top:0;z-index:5;}
    .th{padding:9px 10px;font-size:0.55rem;text-transform:uppercase;letter-spacing:0.9px;color:var(--muted-1,#8ba1c2);
        font-family:'IBM Plex Mono',monospace;font-weight:700;cursor:pointer;user-select:none;white-space:nowrap;
        overflow:hidden;text-overflow:ellipsis;}
    .th.num{text-align:right;}
    .th:hover{color:#7dd3fc;}
    .th .ar{opacity:0.35;margin-left:2px;}
    .th.act .ar{opacity:1;color:#38bdf8;}
    .rowline{border-bottom:1px solid #0c1424;font-family:'IBM Plex Mono',monospace;font-size:0.74rem;}
    .rowline:last-child{border-bottom:none;}
    .rowline:hover{background:#091321;}
    .rowline.sig-long{box-shadow:inset 3px 0 0 #10b981;}
    .rowline.sig-short{box-shadow:inset 3px 0 0 #ef4444;}
    .td{padding:9px 10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
    .td.num{text-align:right;}
    .td.sym{font-weight:700;color:#e0eaf8;font-size:0.78rem;}
    .td.why{white-space:normal;font-size:0.66rem;color:var(--muted-1,#8ba1c2);line-height:1.45;
            display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;}
    .up{color:#34d399;} .down{color:#f87171;} .dim{color:var(--muted-2,#6d85a8);}
    .tag{font-size:0.55rem;font-weight:700;padding:2px 7px;border-radius:4px;letter-spacing:0.6px;display:inline-block;}
    .tag.LONG{background:#04241a;border:1px solid #0e5a3c;color:#34d399;}
    .tag.SHORT{background:#240a0a;border:1px solid #5a1010;color:#f87171;}
    .tag.NONE{background:#0d1524;border:1px solid #1a2a40;color:#6d85a8;}
    .tight{color:#fbbf24;font-size:0.6rem;}
    .empty{padding:34px 18px;text-align:center;color:var(--muted-2,#6d85a8);font-size:0.78rem;line-height:1.6;}

    .sk{margin-top:14px;background:#07111f;border:0.5px solid #0e1e36;border-radius:10px;padding:12px 14px;display:none;}
    .sk.on{display:block;}
    .sk summary{cursor:pointer;font-size:0.68rem;color:var(--muted-1,#8ba1c2);font-family:'IBM Plex Mono',monospace;font-weight:600;}
    .sk-list{margin-top:9px;max-height:230px;overflow-y:auto;font-family:'IBM Plex Mono',monospace;font-size:0.65rem;
             color:var(--muted-2,#6d85a8);line-height:1.75;}
    .sk-list b{color:#8ba1c2;font-weight:600;}

    /* ── Order popup internals ── */
    .ob{text-align:left;}
    .ob-row{display:flex;justify-content:space-between;gap:12px;padding:6px 0;font-family:'IBM Plex Mono',monospace;
            font-size:0.72rem;border-bottom:1px solid #131e30;}
    .ob-row:last-child{border-bottom:none;}
    .ob-row .k{color:var(--muted-2,#6d85a8);}
    .ob-row .v{color:#e0eaf8;font-weight:600;text-align:right;}
    .ob-row.big .v{font-size:0.92rem;color:#7dd3fc;}
    .ob-note{font-size:0.66rem;color:var(--muted-1,#8ba1c2);line-height:1.55;margin:10px 0;}
    .ob-warn{background:#241a04;border:1px solid #5a430e;color:#fbbf24;font-size:0.66rem;line-height:1.5;
             padding:8px 10px;border-radius:6px;margin:10px 0;text-align:left;}
    .ob-danger{background:#240a0a;border:1px solid #5a1010;color:#fca5a5;font-size:0.66rem;line-height:1.5;
               padding:8px 10px;border-radius:6px;margin:10px 0;text-align:left;}
    .qbtns{display:flex;gap:6px;flex-wrap:wrap;margin:-8px 0 14px;}
    .qbtn{background:#0a1526;border:1px solid #14263e;color:var(--muted-1,#8ba1c2);border-radius:6px;padding:5px 10px;
          font-family:'IBM Plex Mono',monospace;font-size:0.64rem;cursor:pointer;}
    .qbtn:hover{border-color:#38bdf8;color:#7dd3fc;}

    /* ── LIGHT SKIN ── */
    :root[data-theme="light"] body{background:#f4f6f9!important;color:#334155!important;}
    :root[data-theme="light"] .ctl,:root[data-theme="light"] .filt,:root[data-theme="light"] .tbl,
    :root[data-theme="light"] .st,:root[data-theme="light"] .sk{background:#fff!important;border-color:#e0e4ea!important;}
    :root[data-theme="light"] .thead{background:#f1f5f9!important;border-bottom-color:#e0e4ea!important;}
    :root[data-theme="light"] .rowline{border-bottom-color:#eef1f5!important;}
    :root[data-theme="light"] .rowline:hover{background:#f8fafc!important;}
    :root[data-theme="light"] .td.sym,:root[data-theme="light"] .hd h1{color:#1e293b!important;}
    :root[data-theme="light"] select,:root[data-theme="light"] input{background:#f8fafc!important;border-color:#e0e4ea!important;color:#334155!important;}
    :root[data-theme="light"] .prog-bar{background:#e2e8f0!important;}
    :root[data-theme="light"] .btn{background:#0369a1!important;border-color:#0369a1!important;color:#fff!important;}
    :root[data-theme="light"] .btn.ghost{background:transparent!important;border-color:#cbd5e1!important;color:#475569!important;}
    :root[data-theme="light"] .btn.buy{background:#047857!important;border-color:#047857!important;color:#fff!important;}
    :root[data-theme="light"] .qbtn{background:#f1f5f9!important;border-color:#e0e4ea!important;color:#475569!important;}
    :root[data-theme="light"] .ob-row{border-bottom-color:#e8ecf1!important;}
    :root[data-theme="light"] .ob-row .v{color:#1e293b!important;}
    :root[data-theme="light"] .sub b{color:#1e293b!important;}

    /* ── MOBILE: the grid becomes a stack of cards ── */
    @media(max-width:900px){
      .ctl-grid{grid-template-columns:1fr 1fr;}
      .ctl-grid .fld.wide{grid-column:1 / -1;}
      .ctl-grid .go{grid-column:1 / -1;}
      .btn{width:100%;}
    }
    @media(max-width:768px){
      .page{padding:14px 12px 70px;}
      .hd h1{font-size:1.08rem;}
      .thead{display:none;}
      .tbl{background:transparent;border:none;border-radius:0;overflow:visible;}
      .rowline{display:block;background:#07111f;border:0.5px solid #0e1e36;border-radius:11px;
               margin-bottom:9px;padding:11px 13px;box-shadow:none;}
      .rowline.sig-long{border-left:3px solid #10b981;}
      .rowline.sig-short{border-left:3px solid #ef4444;}
      .rowline:hover{background:#07111f;}
      .td{display:flex;justify-content:space-between;align-items:baseline;gap:12px;padding:3px 0;white-space:normal;}
      .td::before{content:attr(data-label);font-size:0.55rem;text-transform:uppercase;letter-spacing:0.9px;
                  color:var(--muted-2,#6d85a8);font-weight:700;flex-shrink:0;}
      .td.num{text-align:right;}
      .td.sym{font-size:0.95rem;padding-bottom:7px;}
      .td.sym::before{content:'';}
      .td.why{-webkit-line-clamp:unset;display:block;padding-top:7px;border-top:1px solid #0c1424;margin-top:5px;}
      .td.why::before{display:block;margin-bottom:3px;}
      .td.act{padding-top:10px;}
      .td.act::before{content:'';}
      .td.act .btn.buy{width:100%;min-height:40px;font-size:0.76rem;}
      .td.hide-m{display:none;}
      :root[data-theme="light"] .rowline{background:#fff!important;border-color:#e0e4ea!important;}
      :root[data-theme="light"] .tbl{background:transparent!important;}
      .modal-box{padding:22px 18px 18px;}
    }
    @media(max-width:420px){
      .ctl-grid{grid-template-columns:1fr;}
      .stats{grid-template-columns:1fr 1fr;}
    }
  </style>
</head>
<body>
<div class="app-shell">
${buildSidebar('swingScanner', false)}
  <div class="main-content">
    <div class="page">

      <div class="hd">
        <h1>📈 Swing Scanner</h1>
        <span class="pill info" id="pMarket">…</span>
        <span class="pill" id="pZerodha">…</span>
        <span class="pill" id="pFyers">…</span>
      </div>
      <p class="sub">
        Runs one of your <b>active strategies</b> over a stock universe on the timeframe you choose, and ranks what fires.
        The timeframe here is <b>local to this page</b> — it does not touch Settings and no running strategy sees it.
        Buying places a <b>real Zerodha delivery (CNC) order at market</b>; outside market hours it goes in as an
        <b>AMO</b> for the next session.
        <b>Nothing here manages the position afterwards</b> — the stop in each row is the strategy's suggestion, not an
        order, and no engine will act on it.
      </p>

      <div class="warnbar" id="wBar" style="display:none;"></div>

      <div class="ctl">
        <div class="ctl-grid">
          <div class="fld wide">
            <label for="fStrategy">Strategy <span class="dim" id="stratCount"></span></label>
            <select id="fStrategy"></select>
          </div>
          <div class="fld">
            <label for="fTimeframe">Timeframe</label>
            <select id="fTimeframe"></select>
          </div>
          <div class="fld">
            <label for="fUniverse">Stocks</label>
            <select id="fUniverse"></select>
          </div>
          <div class="fld go">
            <label>&nbsp;</label>
            <button class="btn" id="btnSearch">🔍 Search</button>
          </div>
        </div>
        <div class="hint" id="stratBlurb"></div>
        <div class="prog" id="prog">
          <div class="prog-bar"><div class="prog-fill" id="progFill"></div></div>
          <div class="prog-txt">
            <span id="progTxt">Starting…</span>
            <button class="btn ghost" id="btnCancel" style="padding:3px 12px;min-height:24px;font-size:0.64rem;width:auto;">Cancel</button>
          </div>
        </div>
      </div>

      <div class="stats" id="stats" style="display:none;"></div>

      <div class="filt" id="filt">
        <div class="filt-grid">
          <div class="fld"><label for="qSym">Symbol</label><input id="qSym" type="search" placeholder="e.g. TATA" autocomplete="off"/></div>
          <div class="fld"><label for="qSide">Show</label>
            <select id="qSide">
              <option value="LONG">Long signals only</option>
              <option value="SIG">Any signal (long + short)</option>
              <option value="ALL">Every stock scanned</option>
            </select>
          </div>
          <div class="fld"><label for="qMinPrice">Min price ₹</label><input id="qMinPrice" type="number" min="0" step="1" placeholder="any"/></div>
          <div class="fld"><label for="qMaxPrice">Max price ₹</label><input id="qMaxPrice" type="number" min="0" step="1" placeholder="any"/></div>
          <div class="fld"><label for="qMinScore">Min score</label><input id="qMinScore" type="number" min="0" max="100" step="1" placeholder="0"/></div>
          <div class="fld"><label for="qMaxStop">Max stop %</label><input id="qMaxStop" type="number" min="0" step="0.5" placeholder="any"/></div>
          <div class="fld"><label for="qMinVol">Min vol ×avg</label><input id="qMinVol" type="number" min="0" step="0.1" placeholder="any"/></div>
        </div>
        <div class="filt-foot">
          <span class="cnt" id="cnt"></span>
          <button class="btn ghost" id="btnClear" style="width:auto;">Clear filters</button>
        </div>
      </div>

      <div class="tbl" id="tbl" style="display:none;">
        <div class="thead cols" id="thead"></div>
        <div id="rows"></div>
      </div>

      <details class="sk" id="sk">
        <summary id="skSummary">Skipped symbols</summary>
        <div class="sk-list" id="skList"></div>
      </details>

    </div>
  </div>
</div>

<script>
${toastJS()}
${modalJS()}

// ── State ──────────────────────────────────────────────────────────────────
var META = null, JOB = null, POLL = null, ROWS = [], SORT = { key: 'score', dir: -1 };

var COLS = [
  { key:'symbol',      label:'Symbol',   cls:'sym',        type:'str' },
  { key:'side',        label:'Signal',   cls:'',           type:'str' },
  { key:'ltp',         label:'LTP',      cls:'num',        type:'num' },
  { key:'changePct',   label:'Chg %',    cls:'num',        type:'num' },
  { key:'score',       label:'Score',    cls:'num',        type:'num' },
  { key:'stop',        label:'Stop',     cls:'num',        type:'num' },
  { key:'stopPct',     label:'Stop %',   cls:'num',        type:'num' },
  { key:'target',      label:'Target',   cls:'num hide-m', type:'num' },
  { key:'rr',          label:'R:R',      cls:'num hide-m', type:'num' },
  { key:'volRatio',    label:'Vol ×',    cls:'num',        type:'num' },
  { key:'reason',      label:'Setup',    cls:'why',        type:'str' },
  { key:'_act',        label:'',         cls:'act',        type:'none' }
];

function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g,function(c){
  return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
function inr(n){ return '\\u20B9' + Number(n||0).toLocaleString('en-IN',{maximumFractionDigits:2}); }
function num(n,d){ return (n==null||isNaN(n)) ? '\\u2014' : Number(n).toFixed(d==null?2:d); }

// ── Boot ───────────────────────────────────────────────────────────────────
async function boot(){
  var r = await fetch('/swing-scanner/meta');
  META = await r.json();
  if (!META || !META.success) { showWarn('Could not load the scanner: ' + ((META&&META.error)||'unknown error'), true); return; }

  document.getElementById('pMarket').textContent = META.market.open ? 'Market open' : 'Market closed \\u2192 AMO';
  document.getElementById('pMarket').className = 'pill ' + (META.market.open ? 'ok' : 'info');
  setPill('pZerodha', META.brokers.zerodha.authenticated, 'Zerodha', 'Zerodha not logged in');
  setPill('pFyers',   META.brokers.fyers.authenticated,   'Fyers',   'Fyers not logged in');

  var warns = [];
  if (!META.brokers.fyers.authenticated)
    warns.push('<b>Fyers is not logged in.</b> Candles come from Fyers, so a scan cannot run \\u2014 <a href="/auth/login">log in</a> first.');
  if (!META.brokers.zerodha.authenticated)
    warns.push('<b>Zerodha is not logged in.</b> You can still scan, but the Buy button needs Zerodha \\u2014 <a href="/auth/zerodha">log in</a> to place orders.');
  if (META.universeError)
    warns.push('<b>Custom stock list ignored:</b> ' + esc(META.universeError) + ' (' + esc(META.universeFile) + ')');
  if (!META.strategies.length)
    warns.push('<b>No swing-capable strategy is switched on.</b> Enable EMA_RSI_ST, BB_RSI, Price Action or RSI Pivot ST in Settings \\u2192 Menu Visibility.');
  if (warns.length) showWarn(warns.join('<br>'), !META.brokers.fyers.authenticated || !META.strategies.length);

  var ss = document.getElementById('fStrategy');
  ss.innerHTML = META.strategies.map(function(s){
    return '<option value="' + esc(s.key) + '">' + esc(s.label) + '</option>'; }).join('');
  document.getElementById('stratCount').textContent = '(' + META.strategies.length + ' active)';

  var us = document.getElementById('fUniverse');
  us.innerHTML = META.universes.map(function(u){
    return '<option value="' + esc(u.key) + '">' + esc(u.label) + ' \\u00b7 ' + u.count + (u.source==='custom'?' \\u00b7 custom':'') + '</option>'; }).join('');

  ss.onchange = onStrategyChange;
  onStrategyChange();
  restorePrefs();

  document.getElementById('btnSearch').onclick = startScan;
  document.getElementById('btnCancel').onclick = cancelScan;
  document.getElementById('btnClear').onclick = clearFilters;
  ['qSym','qSide','qMinPrice','qMaxPrice','qMinScore','qMaxStop','qMinVol'].forEach(function(id){
    var el = document.getElementById(id);
    el.addEventListener('input', render);
    el.addEventListener('change', render);
  });
  buildHead();
}

function setPill(id, ok, okText, badText){
  var el = document.getElementById(id);
  el.textContent = ok ? okText : badText;
  el.className = 'pill ' + (ok ? 'ok' : 'bad');
}
function showWarn(html, isErr){
  var w = document.getElementById('wBar');
  w.innerHTML = html; w.style.display = 'block';
  w.className = 'warnbar' + (isErr ? ' err' : '');
}

// The timeframe list is rebuilt per strategy: a strategy that cannot be
// evaluated on a timeframe must not offer it, and must say why.
function onStrategyChange(){
  var key = document.getElementById('fStrategy').value;
  var s = META.strategies.filter(function(x){ return x.key === key; })[0];
  if (!s) return;
  var tfSel = document.getElementById('fTimeframe');
  var prev = tfSel.value;
  tfSel.innerHTML = META.timeframes.map(function(t){
    var ok = s.timeframes.indexOf(t.key) >= 0;
    return '<option value="' + esc(t.key) + '"' + (ok?'':' disabled') + '>' + esc(t.label) + (ok?'':' \\u2014 n/a') + '</option>';
  }).join('');
  var stillOk = s.timeframes.indexOf(prev) >= 0;
  tfSel.value = stillOk ? prev : (s.timeframes.indexOf('60') >= 0 ? '60' : s.timeframes[0]);
  var blurb = s.blurb;
  if (s.timeframes.length < META.timeframes.length && s.timeframeNote) blurb += '  \\u2022  ' + s.timeframeNote;
  if (META.scaling.enabled) blurb += '  \\u2022  Point-based thresholds are rescaled from NIFTY ' + META.scaling.niftyRef + ' to each stock\\u2019s own price.';
  document.getElementById('stratBlurb').textContent = blurb;
  savePrefs();
}

// Remember the three dropdowns so re-opening the page lands where you left it.
function savePrefs(){
  try {
    localStorage.setItem('swingScanner.prefs', JSON.stringify({
      s: document.getElementById('fStrategy').value,
      t: document.getElementById('fTimeframe').value,
      u: document.getElementById('fUniverse').value
    }));
  } catch(e){}
}
function restorePrefs(){
  try {
    var p = JSON.parse(localStorage.getItem('swingScanner.prefs') || '{}');
    if (p.s && document.querySelector('#fStrategy option[value="' + p.s + '"]')) {
      document.getElementById('fStrategy').value = p.s; onStrategyChange();
    }
    var tfo = document.querySelector('#fTimeframe option[value="' + p.t + '"]');
    if (p.t && tfo && !tfo.disabled) document.getElementById('fTimeframe').value = p.t;
    if (p.u && document.querySelector('#fUniverse option[value="' + p.u + '"]')) document.getElementById('fUniverse').value = p.u;
  } catch(e){}
  ['fTimeframe','fUniverse'].forEach(function(id){ document.getElementById(id).onchange = savePrefs; });
}

// ── Scan ───────────────────────────────────────────────────────────────────
async function startScan(){
  savePrefs();
  var q = '?strategy=' + encodeURIComponent(document.getElementById('fStrategy').value)
        + '&timeframe=' + encodeURIComponent(document.getElementById('fTimeframe').value)
        + '&universe=' + encodeURIComponent(document.getElementById('fUniverse').value);
  setBusy(true, 'Starting\\u2026');
  var res, data;
  try { res = await fetch('/swing-scanner/scan' + q); data = await res.json(); }
  catch(e){ setBusy(false); showToast('Could not reach the server', '#ef4444'); return; }
  if (!data.success) { setBusy(false); showToast(data.error, '#ef4444'); showWarn(esc(data.error), true); return; }
  document.getElementById('wBar').style.display = 'none';
  JOB = data.job;
  poll();
}

function poll(){
  if (POLL) clearTimeout(POLL);
  POLL = setTimeout(async function(){
    var r, d;
    try { r = await fetch('/swing-scanner/scan/status?id=' + encodeURIComponent(JOB.id)); d = await r.json(); }
    catch(e){ setBusy(false); showToast('Lost contact with the scan', '#ef4444'); return; }
    if (!d.success) { setBusy(false); showToast(d.error, '#ef4444'); return; }
    JOB = d.job;
    var p = JOB.progress || { done:0, total:0, phase:'' };
    var pct = p.total ? Math.round(p.done / p.total * 100) : 0;
    document.getElementById('progFill').style.width = pct + '%';
    document.getElementById('progTxt').textContent =
      (p.phase === 'evaluating' ? 'Checking setups' : 'Fetching candles') + ' \\u2014 ' + p.done + ' / ' + p.total + ' (' + pct + '%)';
    if (JOB.status === 'running') { poll(); return; }
    setBusy(false);
    if (JOB.status === 'error')     { showWarn('Scan failed: ' + esc(JOB.error), true); showToast('Scan failed', '#ef4444'); return; }
    if (JOB.status === 'cancelled') { showToast('Scan cancelled', '#fbbf24'); return; }
    onResults();
  }, 600);
}

async function cancelScan(){
  if (!JOB) return;
  await fetch('/swing-scanner/scan/cancel?id=' + encodeURIComponent(JOB.id));
}

function setBusy(on, txt){
  document.getElementById('btnSearch').disabled = on;
  document.getElementById('prog').className = 'prog' + (on ? ' on' : '');
  if (txt) document.getElementById('progTxt').textContent = txt;
  if (on) document.getElementById('progFill').style.width = '0%';
}

function onResults(){
  ROWS = JOB.rows || [];
  var s = JOB.stats;
  document.getElementById('stats').style.display = '';
  document.getElementById('stats').innerHTML = [
    st('Long signals', s.long, 'long'),
    st('Short signals', s.short, 'short'),
    st('No signal', s.noSignal, 'dim'),
    st('Skipped', s.skipped, 'dim'),
    st('Scanned', s.scanned, 'dim'),
    st('Took', (s.elapsedMs/1000).toFixed(1) + 's', 'dim')
  ].join('');

  if (JOB.systemic) {
    showWarn('<b>' + JOB.systemic.count + ' of ' + JOB.systemic.total + ' symbols failed the same way</b> \\u2014 '
      + esc(JOB.systemic.reason) + '<br>That is a connection problem, not a stock problem. Check the Fyers login.', true);
  }

  document.getElementById('filt').className = 'filt on';
  document.getElementById('tbl').style.display = '';

  var sk = JOB.skipped || [];
  var skEl = document.getElementById('sk');
  if (sk.length) {
    skEl.className = 'sk on';
    document.getElementById('skSummary').textContent = 'Skipped symbols (' + sk.length + ') \\u2014 why they are not in the list';
    document.getElementById('skList').innerHTML = sk.map(function(x){
      return '<div><b>' + esc(x.symbol) + '</b> \\u2014 ' + esc(x.reason) + '</div>'; }).join('');
  } else { skEl.className = 'sk'; }

  if (s.long === 0 && s.short === 0) showToast('Scan done \\u2014 no setups fired', '#fbbf24');
  else showToast('Scan done \\u2014 ' + s.long + ' long, ' + s.short + ' short', '#10b981');
  render();
}
function st(k, v, cls){
  return '<div class="st"><div class="k">' + k + '</div><div class="v ' + cls + '">' + v + '</div></div>';
}

// ── Table ──────────────────────────────────────────────────────────────────
function buildHead(){
  document.getElementById('thead').innerHTML = COLS.map(function(c){
    var act = SORT.key === c.key;
    if (c.type === 'none') return '<div class="th ' + c.cls + '"></div>';
    return '<div class="th ' + c.cls + (act ? ' act' : '') + '" data-k="' + c.key + '">' + esc(c.label)
         + '<span class="ar">' + (act ? (SORT.dir < 0 ? '\\u25BC' : '\\u25B2') : '\\u2195') + '</span></div>';
  }).join('');
  Array.prototype.forEach.call(document.querySelectorAll('.th[data-k]'), function(el){
    el.onclick = function(){
      var k = el.getAttribute('data-k');
      // First click on a new column sorts DESC for numbers (best first) and
      // ASC for text (A-Z) — the useful direction in each case.
      if (SORT.key === k) SORT.dir = -SORT.dir;
      else { SORT.key = k; SORT.dir = (COLS.filter(function(c){return c.key===k;})[0].type === 'num') ? -1 : 1; }
      buildHead(); render();
    };
  });
}

function passes(r){
  var f = {
    sym:   document.getElementById('qSym').value.trim().toUpperCase(),
    side:  document.getElementById('qSide').value,
    minP:  parseFloat(document.getElementById('qMinPrice').value),
    maxP:  parseFloat(document.getElementById('qMaxPrice').value),
    minS:  parseFloat(document.getElementById('qMinScore').value),
    maxSt: parseFloat(document.getElementById('qMaxStop').value),
    minV:  parseFloat(document.getElementById('qMinVol').value)
  };
  if (f.side === 'LONG' && r.side !== 'LONG') return false;
  if (f.side === 'SIG'  && !r.side) return false;
  if (f.sym && r.symbol.indexOf(f.sym) < 0) return false;
  if (!isNaN(f.minP) && !(r.ltp >= f.minP)) return false;
  if (!isNaN(f.maxP) && !(r.ltp <= f.maxP)) return false;
  if (!isNaN(f.minS) && !(r.score >= f.minS)) return false;
  // A row with no stop cannot satisfy a stop ceiling — excluding it is the
  // honest reading of "show me nothing risking more than X%".
  if (!isNaN(f.maxSt) && !(r.stopPct != null && r.stopPct <= f.maxSt)) return false;
  if (!isNaN(f.minV)  && !(r.volRatio != null && r.volRatio >= f.minV)) return false;
  return true;
}

function render(){
  var list = ROWS.filter(passes);
  var col = COLS.filter(function(c){ return c.key === SORT.key; })[0] || COLS[4];
  list.sort(function(a,b){
    var x = a[SORT.key], y = b[SORT.key];
    // Nulls always sink, whichever way the column is sorted — an empty cell is
    // never "the best row".
    var xn = (x==null||x===''), yn = (y==null||y==='');
    if (xn && yn) return 0;
    if (xn) return 1;
    if (yn) return -1;
    if (col.type === 'num') return (x - y) * SORT.dir;
    return String(x).localeCompare(String(y)) * SORT.dir;
  });

  document.getElementById('cnt').textContent = list.length + ' of ' + ROWS.length + ' shown';
  var host = document.getElementById('rows');
  if (!list.length) {
    host.innerHTML = '<div class="empty">Nothing matches these filters.<br>'
      + (ROWS.length ? 'Try “Any signal” or “Every stock scanned” in <b>Show</b>.' : 'Run a search first.') + '</div>';
    return;
  }
  host.innerHTML = list.map(rowHtml).join('');
  Array.prototype.forEach.call(host.querySelectorAll('button[data-buy]'), function(b){
    b.onclick = function(){ openOrder(b.getAttribute('data-buy')); };
  });
}

function rowHtml(r){
  var sideCls = r.side === 'LONG' ? 'sig-long' : (r.side === 'SHORT' ? 'sig-short' : '');
  var chg = r.changePct == null ? '\\u2014'
          : '<span class="' + (r.changePct >= 0 ? 'up' : 'down') + '">' + (r.changePct>=0?'+':'') + num(r.changePct) + '%</span>';
  // A stop under 0.5% of price is flagged: it is the strategy's own NIFTY-scaled
  // distance, and on a stock chart it sits inside a single bar's noise.
  var tight = (r.stopPct != null && r.stopPct < 0.5) ? ' <span class="tight" title="Very tight for a swing trade">\\u26A0</span>' : '';
  var buy = r.side === 'LONG'
    ? '<button class="btn buy" data-buy="' + esc(r.symbol) + '">Buy</button>'
    : '<span class="dim" style="font-size:0.62rem;" title="' + (r.side === 'SHORT'
        ? 'Short signal \\u2014 a delivery (CNC) buy cannot express it'
        : 'No signal on this bar') + '">\\u2014</span>';

  return '<div class="rowline cols ' + sideCls + '">'
    + '<div class="td sym" data-label="Symbol">' + esc(r.symbol) + '</div>'
    + '<div class="td" data-label="Signal"><span class="tag ' + (r.side||'NONE') + '">' + (r.side||'\\u2014') + '</span></div>'
    + '<div class="td num" data-label="LTP">' + num(r.ltp) + '</div>'
    + '<div class="td num" data-label="Chg %">' + chg + '</div>'
    + '<div class="td num" data-label="Score" title="liquidity ' + r.scoreParts.liquidity + ' + risk ' + r.scoreParts.risk
        + ' + trend ' + r.scoreParts.trend + ' + volume ' + r.scoreParts.volume + '">' + r.score + '</div>'
    + '<div class="td num" data-label="Stop">' + (r.stop==null?'<span class="dim">none</span>':num(r.stop)) + '</div>'
    + '<div class="td num" data-label="Stop %">' + (r.stopPct==null?'\\u2014':num(r.stopPct)+'%'+tight) + '</div>'
    + '<div class="td num hide-m" data-label="Target">' + (r.target==null?'\\u2014':num(r.target)) + '</div>'
    + '<div class="td num hide-m" data-label="R:R">' + (r.rr==null?'\\u2014':num(r.rr)) + '</div>'
    + '<div class="td num" data-label="Vol \\u00d7avg">' + (r.volRatio==null?'\\u2014':num(r.volRatio,1)+'\\u00d7') + '</div>'
    + '<div class="td why" data-label="Setup">' + esc(r.reason) + '</div>'
    + '<div class="td act">' + buy + '</div>'
    + '</div>';
}

function clearFilters(){
  ['qSym','qMinPrice','qMaxPrice','qMinScore','qMaxStop','qMinVol'].forEach(function(id){ document.getElementById(id).value=''; });
  document.getElementById('qSide').value = 'LONG';
  render();
}

// ── Order popup ────────────────────────────────────────────────────────────
async function openOrder(symbol){
  var row = ROWS.filter(function(r){ return r.symbol === symbol; })[0];
  if (!row) return;

  if (!META.brokers.zerodha.authenticated) {
    await showAlert({ icon:'\\uD83D\\uDD12', title:'Zerodha not logged in',
      message:'Orders go to Zerodha. Log in from the sidebar, then come back \\u2014 your scan results stay as they are.',
      btnClass:'modal-btn-danger' });
    return;
  }

  _showModal('<div class="modal-icon">\\uD83D\\uDCB0</div>'
    + '<div class="modal-title">Buy ' + esc(symbol) + '</div>'
    + '<div class="modal-msg" id="obPrice">Fetching live price\\u2026</div>');

  var q, price = row.ltp, source = 'scan', note = null;
  try {
    var rr = await fetch('/swing-scanner/quote?symbol=' + encodeURIComponent(symbol) + '&fallback=' + encodeURIComponent(row.ltp));
    q = await rr.json();
    if (q && q.success) {
      price = q.ltp; source = q.source; note = q.note || null;
      // Adopt the server's freshly-derived plan. A tab opened before 09:15 must
      // not still be promising an AMO once the market has opened under it.
      if (q.plan) {
        META.market.plan = q.plan;
        META.market.open = !!q.marketOpen;
        var mp = document.getElementById('pMarket');
        mp.textContent = q.marketOpen ? 'Market open' : 'Market closed \\u2192 AMO';
        mp.className = 'pill ' + (q.marketOpen ? 'ok' : 'info');
      }
    }
  } catch(e){ note = 'Could not reach the quote service \\u2014 using the scan\\u2019s last close.'; }

  var plan = META.market.plan;
  var body = ''
    + '<div class="modal-icon">\\uD83D\\uDCB0</div>'
    + '<div class="modal-title">Buy ' + esc(symbol) + '</div>'
    + '<div class="ob">'
    +   '<div class="ob-row"><span class="k">Price ' + (source === 'zerodha' ? '(live)' : '(last close)') + '</span><span class="v" id="obLtp">' + inr(price) + '</span></div>'
    +   '<div class="ob-row"><span class="k">Order</span><span class="v">NSE \\u00b7 CNC delivery \\u00b7 MARKET</span></div>'
    +   '<div class="ob-row"><span class="k">Sent as</span><span class="v">' + (plan.isAmo ? 'AMO (next session)' : 'Regular (now)') + '</span></div>'
    + '</div>'
    + (note ? '<div class="ob-warn">' + esc(note) + '</div>' : '')
    + '<div class="ob-note">Quantity (shares)</div>'
    + '<input class="modal-input" id="obQty" type="number" min="1" step="1" inputmode="numeric" value="1" style="margin-bottom:8px;"/>'
    + '<div class="qbtns">'
    +   '<button class="qbtn" data-amt="25000">\\u20B925k</button>'
    +   '<button class="qbtn" data-amt="50000">\\u20B950k</button>'
    +   '<button class="qbtn" data-amt="100000">\\u20B91L</button>'
    +   '<button class="qbtn" data-amt="200000">\\u20B92L</button>'
    + '</div>'
    + '<div class="ob">'
    +   '<div class="ob-row"><span class="k">Order value</span><span class="v" id="obVal">\\u2014</span></div>'
    +   '<div class="ob-row"><span class="k">Est. charges</span><span class="v" id="obChg">\\u2014</span></div>'
    +   '<div class="ob-row big"><span class="k">Total outlay</span><span class="v" id="obTot">\\u2014</span></div>'
    + '</div>'
    + '<div class="ob-warn" id="obPlan">' + esc(plan.reason) + (plan.warning ? ' ' + esc(plan.warning) : '') + '</div>'
    + '<div class="ob-danger">This is a <b>real order</b> with real money. Nothing in this app will manage it afterwards \\u2014 '
    +   'the ' + (row.stop != null ? 'suggested stop of ' + inr(row.stop) : 'strategy stop') + ' is <b>not</b> placed at the exchange.</div>'
    + '<div class="ob-danger" id="obErr" style="display:none;"></div>'
    + '<div class="modal-btns">'
    +   '<button class="modal-btn modal-btn-cancel" id="obCancel">Cancel</button>'
    +   '<button class="modal-btn modal-btn-success" id="obNext">Review \\u2192</button>'
    + '</div>';
  _showModal(body);

  var qtyEl = document.getElementById('obQty');
  function recalc(){
    var qty = parseInt(qtyEl.value, 10);
    var ok = Number.isInteger(qty) && qty > 0;
    var val = ok ? qty * price : 0;
    var chg = ok ? estCharges(val) : 0;
    document.getElementById('obVal').textContent = ok ? inr(val) : '\\u2014';
    document.getElementById('obChg').textContent = ok ? inr(chg) : '\\u2014';
    document.getElementById('obTot').textContent = ok ? inr(val + chg) : '\\u2014';
    var over = val > META.limits.maxOrderValue;
    var err = document.getElementById('obErr');
    if (over) {
      err.style.display = 'block';
      err.innerHTML = 'Over the ' + inr(META.limits.maxOrderValue) + ' per-order ceiling. Reduce the quantity, or raise '
        + '<b>Max order value</b> in Settings \\u2192 Swing Scanner.';
    } else { err.style.display = 'none'; }
    document.getElementById('obNext').disabled = !ok || over;
  }
  qtyEl.addEventListener('input', recalc);
  Array.prototype.forEach.call(document.querySelectorAll('.qbtn'), function(b){
    b.onclick = function(){
      var amt = parseFloat(b.getAttribute('data-amt'));
      qtyEl.value = Math.max(1, Math.floor(amt / price));
      recalc();
    };
  });
  recalc();
  setTimeout(function(){ qtyEl.focus(); qtyEl.select(); }, 60);

  document.getElementById('obCancel').onclick = function(){ _hideModal(); };
  document.getElementById('obNext').onclick = function(){
    var qty = parseInt(qtyEl.value, 10);
    confirmOrder(row, symbol, qty, price, source, plan);
  };
}

// Zerodha delivery: brokerage is zero, the statutory levies are not. Mirrors
// swingScanner.equityBuyCharges on the server; the server figure is the one
// recorded, this is only so the popup can update as you type.
function estCharges(value){
  var stt   = value * 0.001;
  var txn   = value * 0.0000297;
  var sebi  = value * 0.000001;
  var stamp = value * 0.00015;
  var gst   = 0.18 * (txn + sebi);
  return stt + txn + sebi + stamp + gst;
}

async function confirmOrder(row, symbol, qty, price, source, plan){
  var val = qty * price, chg = estCharges(val);
  _showModal('<div class="modal-icon">\\u26A0\\uFE0F</div>'
    + '<div class="modal-title">Place this order?</div>'
    + '<div class="ob">'
    +   '<div class="ob-row big"><span class="k">Buy</span><span class="v">' + qty + ' \\u00d7 ' + esc(symbol) + '</span></div>'
    +   '<div class="ob-row"><span class="k">At</span><span class="v">MARKET \\u00b7 CNC \\u00b7 ' + (plan.isAmo?'AMO':'Regular') + '</span></div>'
    +   '<div class="ob-row"><span class="k">Approx value</span><span class="v">' + inr(val) + '</span></div>'
    +   '<div class="ob-row"><span class="k">Approx total</span><span class="v">' + inr(val + chg) + '</span></div>'
    + '</div>'
    + '<div class="ob-note">A MARKET order fills at whatever the exchange gives, which may differ from '
    +   inr(price) + '. The server re-checks the price and the AMO decision before sending.</div>'
    + '<div class="modal-btns">'
    +   '<button class="modal-btn modal-btn-cancel" id="cfNo">Back</button>'
    +   '<button class="modal-btn modal-btn-danger" id="cfYes">Place real order</button>'
    + '</div>');
  document.getElementById('cfNo').onclick = function(){ _hideModal(); openOrder(symbol); };
  document.getElementById('cfYes').onclick = async function(){
    var btn = this;
    btn.disabled = true; btn.textContent = 'Sending\\u2026';
    var res, d;
    try {
      res = await secretFetch('/swing-scanner/order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol: symbol, qty: qty, ltp: price,
          strategy: document.getElementById('fStrategy').value,
          timeframe: document.getElementById('fTimeframe').value
        }),
        timeoutMs: 30000
      });
      if (res === null) { _hideModal(); return; }   // secret prompt cancelled
      d = await res.json();
    } catch(e){
      btn.disabled = false; btn.textContent = 'Place real order';
      await showAlert({ icon:'\\u274C', title:'Could not reach the server',
        message:'The order was NOT sent. Check your connection and try again.', btnClass:'modal-btn-danger' });
      return;
    }
    _hideModal();
    if (d && d.success) {
      showToast('Order placed \\u2014 ' + d.orderId, '#10b981');
      await showAlert({ icon:'\\u2705', title:'Order placed',
        message: qty + ' \\u00d7 ' + symbol + ' \\u00b7 ' + (d.isAmo ? 'AMO' : 'MARKET') + ' \\u00b7 CNC\\n'
          + 'Order ID: ' + d.orderId + '\\n' + d.message + '\\n\\n'
          + 'Check it in your Zerodha order book. This app will not manage the position.',
        btnClass:'modal-btn-success' });
    } else {
      showToast('Order rejected', '#ef4444');
      await showAlert({ icon:'\\u274C', title:'Order not placed',
        message: (d && d.error) ? d.error : 'Zerodha rejected the order.', btnClass:'modal-btn-danger' });
    }
  };
}

boot();
</script>
</body>
</html>`);
});

module.exports = router;
module.exports._logOrderAttempt = logOrderAttempt;
module.exports._maxOrderValue = maxOrderValue;

/**
 * manualTracker.js — Track & Trail a manually-entered Zerodha trade
 * ─────────────────────────────────────────────────────────────────────────────
 * Use case: You enter a NIFTY option trade manually in Zerodha.
 * This tracker lets you register that entry with the bot, which then:
 *   1. Polls NIFTY spot price every second via Fyers WebSocket (already running)
 *   2. Applies the SAME tiered trail SL logic as paper/live trade
 *   3. Alerts you via Telegram when SL is hit or trail updates
 *   4. Shows a live status page you can watch on phone/desktop
 *
 * Routes:
 *   GET  /tracker/status          → live monitoring dashboard
 *   POST /tracker/register        → register a new manual trade
 *   GET  /tracker/exit            → manually close the tracked position
 *   GET  /tracker/status/data     → JSON poll endpoint (for AJAX refresh)
 *
 * POST /tracker/register body:
 *   {
 *     "side":       "CE" | "PE",
 *     "symbol":     "NSE:NIFTY25APR1024550CE",   // optional — for display only
 *     "strike":     24550,                         // for display
 *     "expiry":     "10 APR 2026",                 // for display
 *     "qty":        65,                            // lot size
 *     "entrySpot":  24300.50,                      // NIFTY spot at your entry
 *     "stopLoss":   24150,                         // your initial SL (NIFTY spot level)
 *     "optionLtp":  180.50,                        // option premium at entry (optional)
 *     "prevCandleHigh": 24380,                     // for 50% mid reference (optional)
 *     "prevCandleLow":  24210,                     // for 50% mid reference (optional)
 *   }
 */

const express  = require("express");
const router   = express.Router();
const fyers    = require("../config/fyers");
const { sendTelegram } = require("../utils/notify");
const { buildSidebar, sidebarCSS, toastJS } = require("../utils/sharedNav");
const sharedSocketState = require("../utils/sharedSocketState");

// ── Trail tier config (same as paper/live) ────────────────────────────────────
const _T1_UPTO = parseFloat(process.env.TRAIL_TIER1_UPTO || "40");
const _T2_UPTO = parseFloat(process.env.TRAIL_TIER2_UPTO || "70");
const _T1_GAP  = parseFloat(process.env.TRAIL_TIER1_GAP  || "60");
const _T2_GAP  = parseFloat(process.env.TRAIL_TIER2_GAP  || "40");
const _T3_GAP  = parseFloat(process.env.TRAIL_TIER3_GAP  || "30");
const _TRAIL_ACTIVATE = parseFloat(process.env.TRAIL_ACTIVATE_PTS || "15");

function getDynamicTrailGap(moveInFavour) {
  if (moveInFavour < _T1_UPTO) return _T1_GAP;
  if (moveInFavour < _T2_UPTO) return _T2_GAP;
  return _T3_GAP;
}

// ── Tracker state ─────────────────────────────────────────────────────────────
let tracker = {
  position:      null,   // null = no active trade
  lastSpot:      null,
  lastSpotTime:  null,
  log:           [],
  pollTimer:     null,
  pollBusy:      false,
};

function istNow() {
  return new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
}

function tlog(msg) {
  const entry = `[${istNow()}] ${msg}`;
  console.log("[TRACKER]", entry);
  tracker.log.push(entry);
  if (tracker.log.length > 500) tracker.log.shift();
}

function inr(n) {
  return typeof n === "number"
    ? `₹${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : "—";
}

// ── Spot price polling (Fyers REST — no socket needed) ────────────────────────
async function fetchSpot() {
  try {
    const res = await fyers.getQuotes(["NSE:NIFTY50-INDEX"]);
    if (res.s === "ok" && res.d && res.d.length > 0) {
      const v   = res.d[0].v || res.d[0];
      const ltp = v.lp || v.ltp || v.last_price || v.last_traded_price;
      if (ltp && ltp > 0) return parseFloat(ltp);
    }
  } catch (e) { /* silent */ }
  return null;
}

// ── Trail SL logic — runs every second ───────────────────────────────────────
async function trackerTick() {
  if (tracker.pollBusy) return;
  tracker.pollBusy = true;
  try {
    if (!tracker.position) { stopTracking(); return; }

    const spot = await fetchSpot();
    if (!spot) return;

    tracker.lastSpot     = spot;
    tracker.lastSpotTime = istNow();

    const pos   = tracker.position;
    const side  = pos.side;
    const TRAIL_ACTIVATE = pos.trailActivatePts || _TRAIL_ACTIVATE;

    // ── Update best price & trail ─────────────────────────────────────────────
    if (side === "CE") {
      if (!pos.bestPrice || spot > pos.bestPrice) pos.bestPrice = spot;
      const moveInFavour = pos.bestPrice - pos.entrySpot;
      if (moveInFavour >= TRAIL_ACTIVATE) {
        const gap      = getDynamicTrailGap(moveInFavour);
        const trailSL  = parseFloat((pos.bestPrice - gap).toFixed(2));
        // 50% floor: trail SL can't go below prevMid until it naturally rises above it
        const floor    = pos.entryPrevMid;
        const effective = floor !== null ? Math.max(trailSL, floor) : trailSL;
        if (effective > pos.stopLoss) {
          tlog(`📈 Trail CE [T${moveInFavour<_T1_UPTO?1:moveInFavour<_T2_UPTO?2:3} gap=${gap}pt]: best=₹${pos.bestPrice} (+${moveInFavour.toFixed(1)}pt) → SL ₹${pos.stopLoss} → ₹${effective}`);
          pos.stopLoss = effective;
          sendTelegram(`📈 [TRACKER] Trail CE updated → SL now ₹${effective} | Best: ₹${pos.bestPrice} (+${moveInFavour.toFixed(1)}pt)`);
        }
      }
      // SL hit check
      if (spot <= pos.stopLoss) {
        tlog(`🛑 SL HIT CE — spot ₹${spot} <= SL ₹${pos.stopLoss}`);
        sendTelegram(`🚨 [TRACKER] SL HIT — NIFTY ₹${spot} crossed below SL ₹${pos.stopLoss}\nClose your CE position in Zerodha NOW!`);
        closePosition(`SL hit — spot ₹${spot} <= SL ₹${pos.stopLoss}`, spot);
      }
    } else {
      if (!pos.bestPrice || spot < pos.bestPrice) pos.bestPrice = spot;
      const moveInFavour = pos.entrySpot - pos.bestPrice;
      if (moveInFavour >= TRAIL_ACTIVATE) {
        const gap      = getDynamicTrailGap(moveInFavour);
        const trailSL  = parseFloat((pos.bestPrice + gap).toFixed(2));
        const ceil     = pos.entryPrevMid;
        const effective = ceil !== null ? Math.min(trailSL, ceil) : trailSL;
        if (effective < pos.stopLoss) {
          tlog(`📉 Trail PE [T${moveInFavour<_T1_UPTO?1:moveInFavour<_T2_UPTO?2:3} gap=${gap}pt]: best=₹${pos.bestPrice} (+${moveInFavour.toFixed(1)}pt) → SL ₹${pos.stopLoss} → ₹${effective}`);
          pos.stopLoss = effective;
          sendTelegram(`📉 [TRACKER] Trail PE updated → SL now ₹${effective} | Best: ₹${pos.bestPrice} (+${moveInFavour.toFixed(1)}pt)`);
        }
      }
      // SL hit check
      if (spot >= pos.stopLoss) {
        tlog(`🛑 SL HIT PE — spot ₹${spot} >= SL ₹${pos.stopLoss}`);
        sendTelegram(`🚨 [TRACKER] SL HIT — NIFTY ₹${spot} crossed above SL ₹${pos.stopLoss}\nClose your PE position in Zerodha NOW!`);
        closePosition(`SL hit — spot ₹${spot} >= SL ₹${pos.stopLoss}`, spot);
      }
    }
  } finally {
    tracker.pollBusy = false;
  }
}

function closePosition(reason, exitSpot) {
  if (!tracker.position) return;
  const pos    = tracker.position;
  const pnlPts = parseFloat(((exitSpot - pos.entrySpot) * (pos.side === "CE" ? 1 : -1)).toFixed(2));
  tlog(`🔴 Position closed: ${reason} | PnL ≈ ${pnlPts >= 0 ? "+" : ""}${pnlPts} NIFTY pts`);
  tracker.position = null;
  stopTracking();
}

function startTracking() {
  stopTracking();
  tracker.pollBusy = false;
  function scheduleNext() {
    if (!tracker.pollTimer) return;
    tracker.pollTimer = setTimeout(async () => {
      await trackerTick();
      scheduleNext();
    }, 1000);
  }
  tracker.pollTimer = true; // placeholder
  trackerTick().then(scheduleNext);
  tlog("📡 Tracker started — polling spot every 1s");
}

function stopTracking() {
  if (tracker.pollTimer && tracker.pollTimer !== true) clearTimeout(tracker.pollTimer);
  tracker.pollTimer = null;
  tracker.pollBusy  = false;
}

// ── Routes ────────────────────────────────────────────────────────────────────

/**
 * POST /tracker/register
 * Register a manual Zerodha trade entry
 */
router.post("/register", (req, res) => {
  const { side, symbol, strike, expiry, qty, entrySpot, stopLoss, optionLtp,
          prevCandleHigh, prevCandleLow } = req.body;

  if (!side || !["CE", "PE"].includes(side))
    return res.status(400).json({ success: false, error: "side must be CE or PE" });
  if (!entrySpot || isNaN(entrySpot))
    return res.status(400).json({ success: false, error: "entrySpot is required" });
  if (!stopLoss || isNaN(stopLoss))
    return res.status(400).json({ success: false, error: "stopLoss is required" });

  // Basic SL sanity
  if (side === "CE" && stopLoss >= entrySpot)
    return res.status(400).json({ success: false, error: "CE stop loss must be BELOW entry spot" });
  if (side === "PE" && stopLoss <= entrySpot)
    return res.status(400).json({ success: false, error: "PE stop loss must be ABOVE entry spot" });

  const prevMid = (prevCandleHigh && prevCandleLow)
    ? parseFloat(((prevCandleHigh + prevCandleLow) / 2).toFixed(2))
    : null;

  const initialSARgap     = Math.abs(entrySpot - stopLoss);
  const trailActivatePts  = Math.min(40, Math.max(_TRAIL_ACTIVATE, Math.round(initialSARgap * 0.25)));

  tracker.position = {
    side,
    symbol:         symbol || `NIFTY ${strike || "?"} ${expiry || "?"} ${side}`,
    strike:         strike || null,
    expiry:         expiry || null,
    qty:            qty || 65,
    entrySpot:      parseFloat(entrySpot),
    stopLoss:       parseFloat(stopLoss),
    initialStopLoss: parseFloat(stopLoss),
    optionLtp:      optionLtp ? parseFloat(optionLtp) : null,
    entryPrevMid:   prevMid,
    trailActivatePts,
    bestPrice:      null,
    entryTime:      istNow(),
  };

  tlog(`✅ Manual trade registered: ${side} | Entry spot ₹${entrySpot} | SL ₹${stopLoss} | TrailActivate: +${trailActivatePts}pt`);
  if (prevMid) tlog(`📐 50% mid reference: ₹${prevMid} (H=${prevCandleHigh} L=${prevCandleLow})`);

  sendTelegram([
    `🎯 [TRACKER] Manual trade registered`,
    ``,
    `Side    : ${side}`,
    `Symbol  : ${tracker.position.symbol}`,
    `Entry   : ₹${entrySpot}`,
    `SL      : ₹${stopLoss}`,
    `Risk    : ${initialSARgap.toFixed(1)} pts`,
    `Opt LTP : ${optionLtp ? "₹" + optionLtp : "—"}`,
    `Trail activates at: +${trailActivatePts}pt`,
    prevMid ? `50% mid : ₹${prevMid}` : "",
  ].filter(Boolean).join("\n"));

  startTracking();

  return res.json({
    success: true,
    message: "Trade registered. Tracker is now monitoring with trail SL.",
    position: tracker.position,
  });
});

/**
 * GET /tracker/exit
 * Manually close the tracked position
 */
router.get("/exit", (req, res) => {
  if (!tracker.position) {
    return res.status(400).json({ success: false, error: "No active tracked position." });
  }
  const exitSpot = tracker.lastSpot || tracker.position.entrySpot;
  const pnlPts   = parseFloat(((exitSpot - tracker.position.entrySpot) * (tracker.position.side === "CE" ? 1 : -1)).toFixed(2));
  tlog(`🖐️ Manual exit by user | Spot ₹${exitSpot} | PnL ≈ ${pnlPts >= 0 ? "+" : ""}${pnlPts} NIFTY pts`);
  sendTelegram(`🖐️ [TRACKER] Manual exit | NIFTY ₹${exitSpot} | PnL ≈ ${pnlPts >= 0 ? "+" : ""}${pnlPts} pts`);
  closePosition("Manual exit by user", exitSpot);
  return res.json({ success: true, message: "Position closed.", exitSpot, pnlPts });
});

/**
 * GET /tracker/status/data
 * JSON poll for AJAX refresh
 */
router.get("/status/data", (req, res) => {
  const pos = tracker.position;
  let unrealisedPts = null;
  if (pos && tracker.lastSpot) {
    unrealisedPts = parseFloat(((tracker.lastSpot - pos.entrySpot) * (pos.side === "CE" ? 1 : -1)).toFixed(2));
  }
  return res.json({
    active:         !!pos,
    lastSpot:       tracker.lastSpot,
    lastSpotTime:   tracker.lastSpotTime,
    unrealisedPts,
    position: pos ? {
      side:           pos.side,
      symbol:         pos.symbol,
      strike:         pos.strike,
      expiry:         pos.expiry,
      qty:            pos.qty,
      entrySpot:      pos.entrySpot,
      stopLoss:       pos.stopLoss,
      initialStopLoss: pos.initialStopLoss,
      optionLtp:      pos.optionLtp,
      entryPrevMid:   pos.entryPrevMid,
      trailActivatePts: pos.trailActivatePts,
      bestPrice:      pos.bestPrice,
      entryTime:      pos.entryTime,
    } : null,
    logs: [...tracker.log].reverse().slice(0, 100),
  });
});

/**
 * GET /tracker/status
 * Live monitoring dashboard
 */
router.get("/status", (req, res) => {
  const pos      = tracker.position;
  const spot     = tracker.lastSpot;
  const pnlColor = (n) => (typeof n === "number" && n >= 0) ? "#10b981" : "#ef4444";

  let unrealisedPts = null;
  if (pos && spot) {
    unrealisedPts = parseFloat(((spot - pos.entrySpot) * (pos.side === "CE" ? 1 : -1)).toFixed(2));
  }

  const moveInFavour = pos && pos.bestPrice
    ? (pos.side === "CE" ? pos.bestPrice - pos.entrySpot : pos.entrySpot - pos.bestPrice)
    : 0;
  const trailActive = moveInFavour >= (pos?.trailActivatePts || _TRAIL_ACTIVATE);
  const slGap = pos && spot
    ? (pos.side === "CE" ? spot - pos.stopLoss : pos.stopLoss - spot).toFixed(1)
    : "—";

  const logsJSON = JSON.stringify([...tracker.log].reverse().slice(0, 200))
    .replace(/<\/script>/gi, "<\\/script>")
    .replace(/`/g, "\\u0060")
    .replace(/\$/g, "\\u0024");

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Manual Trade Tracker</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;600&display=swap" rel="stylesheet"/>
  <style>
    *{box-sizing:border-box;margin:0;padding:0;}
    body{font-family:'Inter',sans-serif;background:#040c18;color:#e0eaf8;overflow-x:hidden;}
    ${sidebarCSS()}
    .sc{background:#07111f;border:0.5px solid #0e1e36;border-radius:9px;padding:14px 16px;position:relative;overflow:hidden;}
    .sc::before{content:'';position:absolute;top:0;left:0;right:0;height:2px;background:var(--accent,#1e3080);}
    .sc-label{font-size:0.58rem;text-transform:uppercase;letter-spacing:1.2px;color:#1e3050;margin-bottom:6px;}
    .sc-val{font-size:1.1rem;font-weight:700;color:#e0eaf8;}
    .sc-sub{font-size:0.62rem;color:#1e3050;margin-top:3px;}
    .stat-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:20px;}
    .section-title{font-size:0.6rem;font-weight:700;text-transform:uppercase;letter-spacing:1.8px;color:#1e3050;margin-bottom:10px;display:flex;align-items:center;gap:8px;}
    .section-title::after{content:'';flex:1;height:0.5px;background:#0e1e36;}
    .log-box{background:#07111f;border:0.5px solid #0e1e36;border-radius:10px;padding:12px;max-height:300px;overflow-y:auto;}
    .log-entry{padding:4px 0;border-bottom:0.5px solid #0e1e36;font-size:0.72rem;font-family:'IBM Plex Mono',monospace;color:#4a6080;line-height:1.4;}
    .badge{display:inline-block;padding:2px 10px;border-radius:4px;font-size:0.7rem;font-weight:700;}
    @keyframes pulse{0%,100%{opacity:1}50%{opacity:0.3}}
    input{background:#07111f;border:0.5px solid #0e1e36;color:#e0eaf8;padding:8px 12px;border-radius:6px;font-size:0.85rem;font-family:'IBM Plex Mono',monospace;width:100%;}
    input:focus{outline:none;border-color:#3b82f6;}
    label{font-size:0.65rem;text-transform:uppercase;letter-spacing:1px;color:#4a6080;display:block;margin-bottom:4px;}
    .form-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-bottom:16px;}
    .submit-btn{background:#065f46;border:0.5px solid #10b981;color:#a7f3d0;padding:10px 24px;border-radius:8px;font-size:0.85rem;font-weight:700;cursor:pointer;font-family:inherit;width:100%;margin-top:8px;}
    .submit-btn:hover{background:#047857;}
    .exit-btn{background:#7f1d1d;border:0.5px solid #ef4444;color:#fca5a5;padding:10px 24px;border-radius:8px;font-size:0.85rem;font-weight:700;cursor:pointer;font-family:inherit;width:100%;margin-top:8px;}
    .exit-btn:hover{background:#991b1b;}
    select{background:#07111f;border:0.5px solid #0e1e36;color:#e0eaf8;padding:8px 12px;border-radius:6px;font-size:0.85rem;font-family:inherit;width:100%;}
  </style>
</head>
<body>
<div class="app-shell">
${buildSidebar("tracker", sharedSocketState.getMode() === "LIVE_TRADE", !!pos, {
  showExitBtn:  !!pos,
  exitBtnJs:    "handleExit(this)",
  exitLabel:    "🚪 Close Trade",
  statusLabel:  pos ? "TRACKING" : "IDLE",
})}
<div class="main-content">
  <div class="top-bar">
    <div>
      <div class="top-bar-title">🎯 Manual Trade Tracker</div>
      <div class="top-bar-meta">Enter your Zerodha trade details — bot applies Trail SL automatically</div>
    </div>
    <div class="top-bar-right">
      ${pos
        ? `<span class="top-bar-badge paper-active" style="animation:pulse 1.2s infinite;"><span style="width:5px;height:5px;border-radius:50%;background:#10b981;display:inline-block;"></span>TRACKING</span>`
        : `<span class="top-bar-badge">● IDLE</span>`}
    </div>
  </div>

  <div class="page">

    <!-- Live spot + position overview -->
    <div class="stat-grid">
      <div class="sc" id="sc-spot" style="--accent:#1e3080;">
        <div class="sc-label">NIFTY Spot</div>
        <div class="sc-val" id="d-spot" style="font-family:'IBM Plex Mono',monospace;">${spot ? inr(spot) : "—"}</div>
        <div class="sc-sub" id="d-spot-time">${tracker.lastSpotTime || "Waiting for first poll..."}</div>
      </div>
      ${pos ? `
      <div class="sc" style="--accent:${pos.side === "CE" ? "#065f46" : "#7f1d1d"};">
        <div class="sc-label">Side</div>
        <div class="sc-val" style="color:${pos.side === "CE" ? "#10b981" : "#ef4444"};font-size:2rem;">${pos.side}</div>
        <div class="sc-sub">${pos.symbol}</div>
      </div>
      <div class="sc" style="--accent:#1e3080;">
        <div class="sc-label">Entry Spot</div>
        <div class="sc-val" style="font-family:'IBM Plex Mono',monospace;">${inr(pos.entrySpot)}</div>
        <div class="sc-sub">${pos.entryTime}</div>
      </div>
      <div class="sc" id="sc-sl" style="--accent:#78350f;">
        <div class="sc-label">Stop Loss (NIFTY)</div>
        <div class="sc-val" id="d-sl" style="font-family:'IBM Plex Mono',monospace;color:#f59e0b;">${inr(pos.stopLoss)}</div>
        <div class="sc-sub">Initial: ${inr(pos.initialStopLoss)}</div>
      </div>
      <div class="sc" id="sc-sl-gap" style="--accent:#78350f;">
        <div class="sc-label">Cushion to SL</div>
        <div class="sc-val" id="d-sl-gap" style="font-family:'IBM Plex Mono',monospace;color:${parseFloat(slGap) < 20 ? "#ef4444" : "#f59e0b"};">${slGap} pts</div>
        <div class="sc-sub">Distance before SL fires</div>
      </div>
      <div class="sc" id="sc-pnl" style="--accent:${unrealisedPts !== null ? (unrealisedPts >= 0 ? "#065f46" : "#7f1d1d") : "#1e3080"};">
        <div class="sc-label">Unrealised PnL (pts)</div>
        <div class="sc-val" id="d-pnl" style="font-family:'IBM Plex Mono',monospace;color:${pnlColor(unrealisedPts)};">${unrealisedPts !== null ? (unrealisedPts >= 0 ? "+" : "") + unrealisedPts + " pts" : "—"}</div>
        <div class="sc-sub">${pos.qty} qty × NIFTY delta (approx)</div>
      </div>
      <div class="sc" id="sc-trail" style="--accent:${trailActive ? "#4c1d95" : "#1e3080"};">
        <div class="sc-label">Trail Status</div>
        <div class="sc-val" id="d-trail" style="color:${trailActive ? "#8b5cf6" : "#f59e0b"};">${trailActive ? "🔒 ACTIVE" : "⏳ Waiting"}</div>
        <div class="sc-sub">Best: <span id="d-best">${pos.bestPrice ? inr(pos.bestPrice) : "—"}</span> | Activates at +${pos.trailActivatePts}pt</div>
      </div>
      <div class="sc" style="--accent:#1e3080;">
        <div class="sc-label">50% Mid Reference</div>
        <div class="sc-val" style="font-family:'IBM Plex Mono',monospace;">${pos.entryPrevMid ? inr(pos.entryPrevMid) : "—"}</div>
        <div class="sc-sub">Trail floor/ceiling</div>
      </div>
      <div class="sc" style="--accent:#1e3080;">
        <div class="sc-label">Option Entry LTP</div>
        <div class="sc-val" style="font-family:'IBM Plex Mono',monospace;">${pos.optionLtp ? inr(pos.optionLtp) : "—"}</div>
        <div class="sc-sub">For your P&L reference</div>
      </div>
      ` : ""}
    </div>

    <!-- Register form — only show when no active position -->
    ${!pos ? `
    <div class="section-title">Register Manual Trade</div>
    <div style="background:#07111f;border:0.5px solid #0e1e36;border-radius:12px;padding:20px 24px;margin-bottom:20px;">
      <div style="font-size:0.8rem;color:#4a6080;margin-bottom:16px;">
        Enter your trade details from Zerodha. The bot will trail the stop loss automatically and alert you via Telegram.
      </div>
      <div class="form-grid">
        <div>
          <label>Side *</label>
          <select id="f-side"><option value="CE">CE (Call — Bullish)</option><option value="PE">PE (Put — Bearish)</option></select>
        </div>
        <div>
          <label>Entry NIFTY Spot * (e.g. 24300.50)</label>
          <input type="number" id="f-spot" placeholder="24300.50" step="0.05"/>
        </div>
        <div>
          <label>Stop Loss — NIFTY level * (e.g. 24150)</label>
          <input type="number" id="f-sl" placeholder="24150" step="0.5"/>
        </div>
        <div>
          <label>Option Premium at Entry (optional)</label>
          <input type="number" id="f-ltp" placeholder="180.50" step="0.05"/>
        </div>
        <div>
          <label>Qty (default 65)</label>
          <input type="number" id="f-qty" placeholder="65" value="65"/>
        </div>
        <div>
          <label>Strike (display only)</label>
          <input type="number" id="f-strike" placeholder="24300"/>
        </div>
        <div>
          <label>Expiry (display only)</label>
          <input type="text" id="f-expiry" placeholder="10 APR 2026"/>
        </div>
        <div>
          <label>Prev Candle High (for 50% mid)</label>
          <input type="number" id="f-ph" placeholder="24380"/>
        </div>
        <div>
          <label>Prev Candle Low (for 50% mid)</label>
          <input type="number" id="f-pl" placeholder="24210"/>
        </div>
      </div>
      <button class="submit-btn" onclick="handleRegister(this)">🎯 Start Tracking This Trade</button>
    </div>
    ` : `
    <button class="exit-btn" style="max-width:300px;" onclick="handleExit(this)">🚪 Exit Trade (close tracker)</button>
    <div style="margin-top:8px;font-size:0.72rem;color:#4a6080;">This closes the tracker only — you still need to close your position in Zerodha manually.</div>
    `}

    <!-- Log -->
    <div class="section-title" style="margin-top:20px;">Tracker Log</div>
    <div class="log-box" id="log-box">
      <!-- populated by JS -->
    </div>

  </div>
</div>
</div>

<script id="init-logs" type="application/json">${logsJSON}</script>
<script>
${toastJS()}

// ── Render logs ───────────────────────────────────────────────────────────────
var LOGS = JSON.parse(document.getElementById('init-logs').textContent);
function renderLogs(logs) {
  var box = document.getElementById('log-box');
  if (!logs || !logs.length) { box.innerHTML = '<div class="log-entry" style="color:#1e3050;">No log entries yet.</div>'; return; }
  box.innerHTML = logs.slice(0, 100).map(function(l) {
    var c = l.indexOf('🛑')>=0||l.indexOf('❌')>=0?'#ef4444':l.indexOf('✅')>=0||l.indexOf('📈')>=0||l.indexOf('📉')>=0?'#10b981':l.indexOf('⏳')>=0||l.indexOf('📡')>=0?'#3b82f6':'#4a6080';
    return '<div class="log-entry" style="color:'+c+';">'+l+'</div>';
  }).join('');
}
renderLogs(LOGS);

// ── AJAX poll every 1.5s ──────────────────────────────────────────────────────
function poll() {
  fetch('/tracker/status/data').then(function(r){ return r.json(); }).then(function(d) {
    var el = function(id) { return document.getElementById(id); };
    if (el('d-spot') && d.lastSpot) {
      el('d-spot').textContent = '₹' + d.lastSpot.toLocaleString('en-IN', {minimumFractionDigits:2,maximumFractionDigits:2});
      el('d-spot-time').textContent = d.lastSpotTime || '';
    }
    if (d.position) {
      if (el('d-sl')) el('d-sl').textContent = '₹' + d.position.stopLoss.toLocaleString('en-IN', {minimumFractionDigits:2,maximumFractionDigits:2});
      if (el('d-pnl') && d.unrealisedPts !== null) {
        var pts = d.unrealisedPts;
        el('d-pnl').textContent = (pts>=0?'+':'')+pts+' pts';
        el('d-pnl').style.color = pts>=0?'#10b981':'#ef4444';
      }
      if (el('d-best') && d.position.bestPrice) {
        el('d-best').textContent = '₹' + d.position.bestPrice.toLocaleString('en-IN',{minimumFractionDigits:2});
      }
      if (el('d-sl-gap') && d.lastSpot && d.position.stopLoss) {
        var gap = d.position.side==='CE' ? d.lastSpot - d.position.stopLoss : d.position.stopLoss - d.lastSpot;
        el('d-sl-gap').textContent = gap.toFixed(1) + ' pts';
        el('d-sl-gap').style.color = gap < 20 ? '#ef4444' : '#f59e0b';
      }
      if (el('d-trail')) {
        var move = d.position.bestPrice ? (d.position.side==='CE' ? d.position.bestPrice - d.position.entrySpot : d.position.entrySpot - d.position.bestPrice) : 0;
        var active = move >= (d.position.trailActivatePts || 15);
        el('d-trail').textContent = active ? '🔒 ACTIVE' : '⏳ Waiting';
        el('d-trail').style.color = active ? '#8b5cf6' : '#f59e0b';
      }
    }
    if (d.logs) renderLogs(d.logs);
    // If position was just closed, reload page
    if (!d.active && document.querySelector('.exit-btn')) {
      setTimeout(function(){ location.reload(); }, 2000);
    }
  }).catch(function(){});
}
setInterval(poll, 1500);

// ── Register ──────────────────────────────────────────────────────────────────
async function handleRegister(btn) {
  var g = function(id) { return document.getElementById(id) ? document.getElementById(id).value.trim() : ''; };
  var body = {
    side:            g('f-side'),
    entrySpot:       parseFloat(g('f-spot')),
    stopLoss:        parseFloat(g('f-sl')),
    optionLtp:       g('f-ltp') ? parseFloat(g('f-ltp')) : undefined,
    qty:             g('f-qty') ? parseInt(g('f-qty')) : 65,
    strike:          g('f-strike') ? parseInt(g('f-strike')) : undefined,
    expiry:          g('f-expiry') || undefined,
    prevCandleHigh:  g('f-ph') ? parseFloat(g('f-ph')) : undefined,
    prevCandleLow:   g('f-pl') ? parseFloat(g('f-pl')) : undefined,
  };
  if (!body.entrySpot || isNaN(body.entrySpot)) { showToast('❌ Enter valid NIFTY spot', '#ef4444'); return; }
  if (!body.stopLoss  || isNaN(body.stopLoss))  { showToast('❌ Enter valid stop loss',  '#ef4444'); return; }
  if (btn) { btn.textContent = '⏳ Registering...'; btn.disabled = true; }
  try {
    var res = await fetch('/tracker/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    var data = await res.json();
    if (!data.success) {
      showToast('❌ ' + (data.error || 'Failed'), '#ef4444');
      if (btn) { btn.textContent = '🎯 Start Tracking This Trade'; btn.disabled = false; }
    } else {
      showToast('✅ Trade registered! Tracker active.', '#10b981');
      setTimeout(function(){ location.reload(); }, 1000);
    }
  } catch(e) {
    showToast('❌ ' + e.message, '#ef4444');
    if (btn) { btn.textContent = '🎯 Start Tracking This Trade'; btn.disabled = false; }
  }
}

async function handleExit(btn) {
  if (!confirm('Close this tracked position?\\n(You still need to close it in Zerodha separately)')) return;
  if (btn) { btn.textContent = '⏳ Exiting...'; btn.disabled = true; }
  try {
    var res = await fetch('/tracker/exit');
    var data = await res.json();
    showToast(data.success ? '🚪 Tracker closed' : '❌ ' + data.error, data.success ? '#f59e0b' : '#ef4444');
    if (data.success) setTimeout(function(){ location.reload(); }, 1000);
    else if (btn) { btn.textContent = '🚪 Close Trade'; btn.disabled = false; }
  } catch(e) {
    showToast('❌ ' + e.message, '#ef4444');
    if (btn) { btn.textContent = '🚪 Close Trade'; btn.disabled = false; }
  }
}
</script>
</body>
</html>`;

  res.setHeader("Content-Type", "text/html");
  return res.send(html);
});

module.exports = router;

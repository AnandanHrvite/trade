/**
 * manualTracker.js — Automatic Zerodha Position Tracker
 * ─────────────────────────────────────────────────────────────────────────────
 * Workflow:
 *   1. User takes entry in Zerodha manually
 *   2. Clicks "Fetch & Start Tracking" — zero manual input needed
 *   3. Bot reads open NIFTY position from Zerodha (symbol, qty, avg price)
 *   4. Fetches candles + runs the swing strategy → initial SL = previous-candle low/high
 *      (SAR value as fallback when no signal is live)
 *   5. Polls NIFTY spot every 1 second via Fyers REST
 *   6. Trails SL the same way as paper/live: tighten to each completed candle's
 *      low (CE) / high (PE), plus breakeven (SL → entry after +BREAKEVEN_PTS)
 *   7. Sends Telegram alert when SL is hit
 *   8. Marks position closed (user still exits in Zerodha manually)
 */

const express = require("express");
const router  = express.Router();
const fyers   = require("../config/fyers");
const { sendTelegram } = require("../utils/notify");
const { buildSidebar, sidebarCSS, toastJS, faviconLink, modalCSS, modalJS } = require("../utils/sharedNav");
const sharedSocketState = require("../utils/sharedSocketState");

// Trailing config (mirrors the swing strategy): prev-candle trail + breakeven.
function _bePts()   { return parseFloat(process.env.BREAKEVEN_PTS || "25"); }
function _resMin()  { return parseInt(process.env.TRADE_RESOLUTION || "5", 10); }

// Last FULLY-COMPLETED candle's low (CE) / high (PE) — the prev-candle trail reference.
async function fetchPrevCandleExtreme(side) {
  try {
    const { fetchCandles } = require("../services/backtestEngine");
    const { fetchCandlesCached } = require("../utils/candleCache");
    const resMin  = _resMin();
    const today   = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    const from    = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
    from.setDate(from.getDate() - 5);
    const fromStr = from.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    const candles = await fetchCandlesCached("NSE:NIFTY50-INDEX", String(resMin), fromStr, today, fetchCandles);
    const nowSec  = Math.floor(Date.now() / 1000);
    const done    = candles.filter(c => (c.time + resMin * 60) <= nowSec); // fully closed only
    if (!done.length) return null;
    const last = done[done.length - 1];
    return parseFloat((side === "CE" ? last.low : last.high).toFixed(2));
  } catch (_) { return null; }
}

// ── State ────────────────────────────────────────────────────────────────────
let tracker = {
  position: null, lastSpot: null, lastSpotTime: null,
  log: [], pollTimer: null, pollBusy: false,
  status: "idle", // idle | tracking | sl_hit | exited
};

function istNow() {
  return new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
}
function tlog(msg) {
  const e = `[${istNow()}] ${msg}`;
  console.log("[TRACKER]", e);
  tracker.log.push(e);
  if (tracker.log.length > 500) tracker.log.shift();
}

async function fetchSpot() {
  try {
    const r = await fyers.getQuotes(["NSE:NIFTY50-INDEX"]);
    if (r.s === "ok" && r.d && r.d.length > 0) {
      const v = r.d[0].v || r.d[0];
      const ltp = v.lp || v.ltp || v.last_price;
      if (ltp && ltp > 0) return parseFloat(ltp);
    }
  } catch (_) {}
  return null;
}

async function computeSLFromSAR(side) {
  try {
    const { fetchCandles } = require("../services/backtestEngine");
    const { fetchCandlesCached } = require("../utils/candleCache");
    const { getActiveStrategy } = require("../strategies");
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    const from  = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
    from.setDate(from.getDate() - 5);
    const fromStr = from.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    tlog(`📊 Loading 15-min candles for SAR SL (cache-first)...`);
    // Uses disk cache — only calls API for today's new bars
    const candles = await fetchCandlesCached("NSE:NIFTY50-INDEX", "15", fromStr, today, fetchCandles);
    if (candles.length < 30) { tlog(`⚠️ Only ${candles.length} candles — using fallback SL`); return null; }
    const result = getActiveStrategy().getSignal(candles.slice(-60), { silent: true });
    // Prefer the strategy's prev-candle SL; fall back to the SAR value when no signal is live.
    if (result.stopLoss && typeof result.stopLoss === "number") {
      tlog(`✅ Initial SL (prev-candle): ₹${result.stopLoss} | Signal: ${result.signal}`);
      return parseFloat(result.stopLoss.toFixed(2));
    }
    if (result.sar && typeof result.sar === "number") {
      tlog(`✅ Initial SL (SAR fallback): ₹${result.sar} | Signal: ${result.signal}`);
      return parseFloat(result.sar.toFixed(2));
    }
    tlog(`⚠️ SL not available (${result.reason ? result.reason.slice(0,60) : "no reason"})`);
    return null;
  } catch (err) {
    tlog(`⚠️ SAR computation error: ${err.message}`);
    return null;
  }
}

function parseZerodhaSymbol(sym) {
  const side = sym.endsWith("CE") ? "CE" : sym.endsWith("PE") ? "PE" : null;
  if (!side) return null;
  const strikeMatch = sym.match(/(\d{4,6})(CE|PE)$/);
  const strike = strikeMatch ? parseInt(strikeMatch[1]) : null;
  const dateMatch = sym.match(/NIFTY(\d{2})([A-Z]{3})(\d{2})/);
  const expiry = dateMatch ? `${dateMatch[3]} ${dateMatch[2]} 20${dateMatch[1]}` : null;
  return { side, strike, expiry };
}

// ── Poll tick ─────────────────────────────────────────────────────────────────
async function trackerTick() {
  if (tracker.pollBusy || !tracker.position) return;
  tracker.pollBusy = true;
  try {
    const spot = await fetchSpot();
    if (!spot) return;
    tracker.lastSpot = spot; tracker.lastSpotTime = istNow();
    const pos = tracker.position;
    const bePts = _bePts();

    // Track favourable extreme (for display)
    if (pos.side === "CE") { if (!pos.bestPrice || spot > pos.bestPrice) pos.bestPrice = spot; }
    else                   { if (!pos.bestPrice || spot < pos.bestPrice) pos.bestPrice = spot; }

    // ── Prev-candle trailing: once per completed candle, tighten SL to that candle's low/high ──
    const resMin = _resMin();
    const bucket = Math.floor(Date.now() / (resMin * 60 * 1000));
    if (pos._lastTrailBucket == null) pos._lastTrailBucket = bucket;
    else if (bucket !== pos._lastTrailBucket) {
      pos._lastTrailBucket = bucket;
      const ref = await fetchPrevCandleExtreme(pos.side);
      if (ref != null) {
        if (pos.side === "CE" && ref > pos.stopLoss) {
          tlog(`📐 Trail CE → prev-candle low ₹${ref} (was ₹${pos.stopLoss})`);
          pos.stopLoss = ref;
          sendTelegram(`📐 [TRACKER] Trail CE → SL ₹${ref} (prev-candle low)`);
        } else if (pos.side === "PE" && ref < pos.stopLoss) {
          tlog(`📐 Trail PE → prev-candle high ₹${ref} (was ₹${pos.stopLoss})`);
          pos.stopLoss = ref;
          sendTelegram(`📐 [TRACKER] Trail PE → SL ₹${ref} (prev-candle high)`);
        }
      }
    }

    // ── Breakeven: once +BREAKEVEN_PTS in favour, move SL to entry (tighten-only) ──
    const move = pos.side === "CE" ? (spot - pos.entrySpot) : (pos.entrySpot - spot);
    if (move >= bePts) {
      if (pos.side === "CE" && pos.stopLoss < pos.entrySpot) { pos.stopLoss = parseFloat(pos.entrySpot.toFixed(2)); tlog(`✅ Breakeven CE → SL=entry ₹${pos.entrySpot}`); }
      if (pos.side === "PE" && pos.stopLoss > pos.entrySpot) { pos.stopLoss = parseFloat(pos.entrySpot.toFixed(2)); tlog(`✅ Breakeven PE → SL=entry ₹${pos.entrySpot}`); }
    }

    // ── SL hit ──
    if (pos.side === "CE" && spot <= pos.stopLoss) {
      tlog(`🛑 SL HIT CE — spot ₹${spot} <= SL ₹${pos.stopLoss}`);
      sendTelegram(`🚨 [TRACKER] SL HIT — NIFTY ₹${spot} crossed below ₹${pos.stopLoss}\n⚡ Close your CE in Zerodha NOW!`);
      tracker.status = "sl_hit"; tracker.position = null; stopTracking();
    } else if (pos.side === "PE" && spot >= pos.stopLoss) {
      tlog(`🛑 SL HIT PE — spot ₹${spot} >= SL ₹${pos.stopLoss}`);
      sendTelegram(`🚨 [TRACKER] SL HIT — NIFTY ₹${spot} crossed above ₹${pos.stopLoss}\n⚡ Close your PE in Zerodha NOW!`);
      tracker.status = "sl_hit"; tracker.position = null; stopTracking();
    }
  } finally { tracker.pollBusy = false; }
}

function startTracking() {
  stopTracking(); tracker.pollBusy = false; tracker.status = "tracking";
  tracker._active = true;
  function next() {
    if (!tracker._active) return;
    tracker.pollTimer = setTimeout(async () => { await trackerTick(); next(); }, 1000);
  }
  trackerTick().then(next).catch(next);
  tlog("📡 Tracking started — polling NIFTY every 1s");
}
function stopTracking() {
  tracker._active = false;
  if (tracker.pollTimer) clearTimeout(tracker.pollTimer);
  tracker.pollTimer = null; tracker.pollBusy = false;
}

// ── Routes ────────────────────────────────────────────────────────────────────

router.get("/fetch-and-start", async (req, res) => {
  try {
    const zerodha = require("../services/zerodhaBroker");
    if (!zerodha.isAuthenticated())
      return res.status(400).json({ success: false, error: "Zerodha not logged in. Login first via Dashboard." });

    const positions = await zerodha.getPositions();
    const net = (positions.net || []).filter(p =>
      p.quantity !== 0 && p.tradingsymbol &&
      p.tradingsymbol.startsWith("NIFTY") &&
      (p.tradingsymbol.endsWith("CE") || p.tradingsymbol.endsWith("PE"))
    );
    if (net.length === 0)
      return res.json({ success: false, error: "No open NIFTY option position in Zerodha. Take your entry first." });

    const zPos   = net[0];
    const sym    = zPos.tradingsymbol;
    const parsed = parseZerodhaSymbol(sym);
    if (!parsed) return res.json({ success: false, error: `Cannot parse symbol: ${sym}` });

    const { side, strike, expiry } = parsed;
    const qty       = Math.abs(zPos.quantity);
    const optionLtp = parseFloat(zPos.average_price || zPos.buy_price || 0) || null;
    tlog(`📥 Zerodha: ${sym} | ${side} | qty=${qty} | avg=₹${optionLtp}`);

    const spot = await fetchSpot();
    if (!spot) return res.json({ success: false, error: "Cannot fetch NIFTY spot from Fyers. Check Fyers login." });
    tlog(`📍 NIFTY spot: ₹${spot}`);

    let sl = await computeSLFromSAR(side);
    if (!sl) {
      sl = side === "CE" ? parseFloat((spot - 60).toFixed(2)) : parseFloat((spot + 60).toFixed(2));
      tlog(`⚠️ Fallback SL: ₹${sl} (spot ± 60pt)`);
    }
    if (side === "CE" && sl >= spot) { sl = parseFloat((spot - 60).toFixed(2)); tlog(`⚠️ SAR above spot for CE — corrected to spot-60`); }
    if (side === "PE" && sl <= spot) { sl = parseFloat((spot + 60).toFixed(2)); tlog(`⚠️ SAR below spot for PE — corrected to spot+60`); }

    const sarGap = Math.abs(spot - sl);
    const bePts  = _bePts();

    tracker.position = {
      side, symbol: sym, strike, expiry, qty,
      entrySpot: spot, stopLoss: sl, initialStopLoss: sl,
      optionLtp, breakevenPts: bePts,
      bestPrice: null, entryTime: istNow(), sarGap, _lastTrailBucket: null,
    };

    tlog(`✅ TRACKING: ${side} ${sym} | spot=₹${spot} | SL=₹${sl} (${sarGap.toFixed(1)}pt) | prev-candle trail + breakeven +${bePts}pt`);
    sendTelegram([
      `🎯 [TRACKER] Auto-tracking started`,
      ``, `${side === "CE" ? "📈 CE (Call — Bullish)" : "📉 PE (Put — Bearish)"}`,
      `Symbol  : ${sym}`,
      `Strike  : ${strike || "—"} | Expiry: ${expiry || "—"}`,
      `Qty     : ${qty}`,
      ``,
      `NIFTY Spot : ₹${spot}`,
      `Initial SL : ₹${sl}  (${sarGap.toFixed(1)}pt gap)`,
      `Trail      : prev-candle low/high | breakeven +${bePts}pt`,
      `Opt Avg LTP: ${optionLtp ? "₹" + optionLtp : "—"}`,
    ].join("\n"));

    startTracking();
    return res.json({ success: true, message: `Tracking ${side} ${sym} | SL ₹${sl} | prev-candle trail + BE +${bePts}pt`, position: tracker.position });
  } catch (err) {
    tlog(`❌ fetch-and-start: ${err.message}`);
    return res.status(500).json({ success: false, error: err.message });
  }
});

router.get("/exit", (req, res) => {
  if (!tracker.position && tracker.status !== "tracking")
    return res.status(400).json({ success: false, error: "No active tracked position." });
  tlog(`🖐️ Manual exit | last spot ₹${tracker.lastSpot || "—"}`);
  sendTelegram(`🖐️ [TRACKER] Manually stopped.\nClose your position in Zerodha!`);
  tracker.position = null; tracker.status = "exited"; stopTracking();
  return res.json({ success: true, message: "Tracker stopped." });
});

router.get("/status/data", (req, res) => {
  const pos = tracker.position;
  let unrealisedPts = null;
  if (pos && tracker.lastSpot)
    unrealisedPts = parseFloat(((tracker.lastSpot - pos.entrySpot) * (pos.side === "CE" ? 1 : -1)).toFixed(2));
  return res.json({
    status: tracker.status, active: !!pos,
    lastSpot: tracker.lastSpot, lastSpotTime: tracker.lastSpotTime,
    unrealisedPts,
    position: pos ? { side: pos.side, symbol: pos.symbol, strike: pos.strike, expiry: pos.expiry,
      qty: pos.qty, entrySpot: pos.entrySpot, stopLoss: pos.stopLoss, initialStopLoss: pos.initialStopLoss,
      optionLtp: pos.optionLtp, breakevenPts: pos.breakevenPts, bestPrice: pos.bestPrice,
      sarGap: pos.sarGap, entryTime: pos.entryTime } : null,
    logs: [...tracker.log].reverse().slice(0, 100),
  });
});

router.get("/status", (req, res) => {
  const pos = tracker.position;
  const spot = tracker.lastSpot;
  const pc = (n) => n >= 0 ? "#10b981" : "#ef4444";
  let uPts = null;
  if (pos && spot) uPts = parseFloat(((spot - pos.entrySpot) * (pos.side === "CE" ? 1 : -1)).toFixed(2));
  const move = pos && spot ? (pos.side === "CE" ? spot - pos.entrySpot : pos.entrySpot - spot) : 0;
  const beReached = pos ? move >= (pos.breakevenPts || _bePts()) : false;
  const slGap = pos && spot ? parseFloat((pos.side === "CE" ? spot - pos.stopLoss : pos.stopLoss - spot).toFixed(1)) : null;

  const statusBanner = tracker.status === "sl_hit"
    ? `<div style="background:#1a0505;border:1px solid #ef4444;border-radius:10px;padding:16px 20px;margin-bottom:16px;display:flex;align-items:center;gap:12px;"><span style="font-size:1.5rem;">🚨</span><div><div style="font-size:0.85rem;font-weight:700;color:#ef4444;">SL HIT — Close your position in Zerodha</div><div style="font-size:0.72rem;color:#9a3030;margin-top:3px;">Telegram alert sent.</div></div></div>`
    : tracker.status === "exited"
    ? `<div style="background:#07111f;border:0.5px solid #0e1e36;border-radius:10px;padding:14px 20px;margin-bottom:16px;"><div style="font-size:0.8rem;color:#4a6080;">Tracker stopped. No active position being monitored.</div></div>`
    : "";

  const logsJSON = JSON.stringify([...tracker.log].reverse().slice(0,200))
    .replace(/<\/script>/gi,"<\\/script>").replace(/`/g,"\\u0060").replace(/\$/g,"\\u0024");

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  ${faviconLink()}
  <title>Trade Tracker</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;600&display=swap" rel="stylesheet"/>
  <style>
    *{box-sizing:border-box;margin:0;padding:0;}
    body{font-family:'Inter',sans-serif;background:#040c18;color:#e0eaf8;overflow-x:hidden;}
    ${sidebarCSS()}
    ${modalCSS()}
    .sc{background:#07111f;border:0.5px solid #0e1e36;border-radius:9px;padding:14px 16px;position:relative;overflow:hidden;}
    .sc::before{content:'';position:absolute;top:0;left:0;right:0;height:2px;background:var(--accent,#1e3080);}
    .sc-label{font-size:0.58rem;text-transform:uppercase;letter-spacing:1.2px;color:#1e3050;margin-bottom:6px;}
    .sc-val{font-size:1.1rem;font-weight:700;color:#e0eaf8;font-family:'IBM Plex Mono',monospace;}
    .sc-sub{font-size:0.62rem;color:#1e3050;margin-top:3px;}
    .stat-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;margin-bottom:20px;}
    .section-title{font-size:0.6rem;font-weight:700;text-transform:uppercase;letter-spacing:1.8px;color:#1e3050;margin-bottom:10px;display:flex;align-items:center;gap:8px;}
    .section-title::after{content:'';flex:1;height:0.5px;background:#0e1e36;}
    .log-box{background:#07111f;border:0.5px solid #0e1e36;border-radius:10px;padding:12px;max-height:300px;overflow-y:auto;}
    .log-entry{padding:4px 0;border-bottom:0.5px solid #0a1220;font-size:0.72rem;font-family:'IBM Plex Mono',monospace;color:#4a6080;line-height:1.4;}
    @keyframes pulse{0%,100%{opacity:1}50%{opacity:0.3}}
  </style>
</head>
<body>
<div class="app-shell">
${buildSidebar("swingTracker", sharedSocketState.getMode()==="SWING_LIVE", !!pos, {
  showExitBtn: !!pos, exitBtnJs: "handleExit(this)", exitLabel: "🛑 Stop Tracking",
  statusLabel: pos ? "TRACKING" : tracker.status === "sl_hit" ? "SL HIT" : "IDLE",
})}
<div class="main-content">
  <div class="top-bar">
    <div>
      <div class="top-bar-title">🎯 Auto Trade Tracker</div>
      <div class="top-bar-meta">Reads your Zerodha entry → prev-candle Stop Loss → trails automatically</div>
    </div>
    <div class="top-bar-right">
      ${pos ? `<span class="top-bar-badge paper-active" style="animation:pulse 1.2s infinite;"><span style="width:5px;height:5px;border-radius:50%;background:#10b981;display:inline-block;"></span>TRACKING</span>`
             : `<span class="top-bar-badge">● ${tracker.status==="sl_hit"?"SL HIT":"IDLE"}</span>`}
    </div>
  </div>
  <div class="page">
    ${statusBanner}
    ${!pos ? `
    <div style="text-align:center;padding:40px 20px 28px;">
      <div style="font-size:0.85rem;font-weight:600;color:#e0eaf8;margin-bottom:8px;">Take your entry in Zerodha first, then click below.</div>
      <div style="font-size:0.75rem;color:#4a6080;margin-bottom:28px;max-width:480px;margin-left:auto;margin-right:auto;line-height:1.6;">
        Bot will read your open NIFTY position from Zerodha, set the initial Stop Loss to the previous candle's low/high (SAR fallback), then trail it automatically — tightening to each completed candle's low/high plus breakeven — the same way as the live trade engine.
      </div>
      <button id="fetch-btn" onclick="handleFetch(this)"
        style="background:#0a1e3d;border:1px solid #3b82f6;color:#60a5fa;padding:14px 32px;border-radius:10px;font-size:0.95rem;font-weight:700;cursor:pointer;font-family:inherit;display:inline-flex;align-items:center;gap:10px;">
        📥 Fetch from Zerodha &amp; Start Tracking
      </button>
      <div id="fetch-msg" style="margin-top:14px;font-size:0.78rem;color:#4a6080;min-height:22px;"></div>
    </div>
    ` : `
    <div class="stat-grid">
      <div class="sc" style="--accent:${pos.side==="CE"?"#065f46":"#7f1d1d"};">
        <div class="sc-label">Side</div>
        <div class="sc-val" style="font-size:2rem;color:${pos.side==="CE"?"#10b981":"#ef4444"};">${pos.side}</div>
        <div class="sc-sub">${pos.symbol}</div>
      </div>
      <div class="sc" style="--accent:#1e3080;">
        <div class="sc-label">NIFTY Spot</div>
        <div class="sc-val" id="d-spot">${spot?"₹"+spot.toLocaleString("en-IN",{minimumFractionDigits:2}):"—"}</div>
        <div class="sc-sub" id="d-spot-time">${tracker.lastSpotTime||"Polling..."}</div>
      </div>
      <div class="sc" style="--accent:#78350f;">
        <div class="sc-label">Stop Loss (NIFTY)</div>
        <div class="sc-val" id="d-sl" style="color:#f59e0b;">₹${pos.stopLoss.toLocaleString("en-IN",{minimumFractionDigits:2})}</div>
        <div class="sc-sub">Initial: ₹${pos.initialStopLoss} | SAR gap: ${pos.sarGap?.toFixed(1)}pt</div>
      </div>
      <div class="sc" style="--accent:${slGap!==null&&slGap<20?"#7f1d1d":"#78350f"};">
        <div class="sc-label">Cushion to SL</div>
        <div class="sc-val" id="d-cushion" style="color:${slGap!==null&&slGap<20?"#ef4444":"#f59e0b"};">${slGap!==null?slGap+" pt":"—"}</div>
        <div class="sc-sub">Distance before SL fires</div>
      </div>
      <div class="sc" style="--accent:${uPts!==null?(uPts>=0?"#065f46":"#7f1d1d"):"#1e3080"};">
        <div class="sc-label">Unrealised (pts)</div>
        <div class="sc-val" id="d-pnl" style="color:${pc(uPts||0)};">${uPts!==null?(uPts>=0?"+":"")+uPts+" pt":"—"}</div>
        <div class="sc-sub">${pos.qty} qty × NIFTY pts</div>
      </div>
      <div class="sc" style="--accent:${beReached?"#4c1d95":"#1e3080"};">
        <div class="sc-label">Trailing Stop</div>
        <div class="sc-val" id="d-trail" style="color:${beReached?"#8b5cf6":"#f59e0b"};">${beReached?"🔒 Breakeven+":"Prev-candle "+(pos.side==="CE"?"low":"high")}</div>
        <div class="sc-sub">Best: <span id="d-best">${pos.bestPrice?"₹"+pos.bestPrice:"—"}</span> | Breakeven at +${pos.breakevenPts||_bePts()}pt</div>
      </div>
      <div class="sc" style="--accent:#1e3080;">
        <div class="sc-label">Strike / Expiry</div>
        <div class="sc-val" style="font-size:0.95rem;">${pos.strike||"—"}</div>
        <div class="sc-sub">${pos.expiry||"—"}</div>
      </div>
      <div class="sc" style="--accent:#1e3080;">
        <div class="sc-label">Option Avg (Zerodha)</div>
        <div class="sc-val">${pos.optionLtp?"₹"+pos.optionLtp:"—"}</div>
        <div class="sc-sub">Your entry premium</div>
      </div>
    </div>
    <button onclick="handleExit(this)" style="background:#7f1d1d;border:1px solid #ef4444;color:#fca5a5;padding:10px 22px;border-radius:8px;font-size:0.82rem;font-weight:700;cursor:pointer;font-family:inherit;">🛑 Stop Tracking</button>
    <div style="margin-top:6px;font-size:0.7rem;color:#4a6080;">Stops the bot. Close your actual position in Zerodha separately.</div>
    `}
    <div class="section-title" style="margin-top:20px;">Activity Log</div>
    <div class="log-box" id="log-box"></div>
  </div>
</div>
</div>
<script id="init-logs" type="application/json">${logsJSON}</script>
<script>
${modalJS()}
${toastJS()}
var LOGS=JSON.parse(document.getElementById('init-logs').textContent);
function renderLogs(logs){
  var box=document.getElementById('log-box'); if(!box) return;
  if(!logs||!logs.length){box.innerHTML='<div class="log-entry" style="color:#1e3050;">No activity yet.</div>';return;}
  box.innerHTML=logs.slice(0,100).map(function(l){
    var c=l.indexOf('🛑')>=0||l.indexOf('❌')>=0?'#ef4444':l.indexOf('✅')>=0||l.indexOf('📈')>=0||l.indexOf('📉')>=0?'#10b981':l.indexOf('📡')>=0||l.indexOf('📥')>=0?'#3b82f6':'#4a6080';
    return '<div class="log-entry" style="color:'+c+';">'+l+'</div>';
  }).join('');
}
renderLogs(LOGS);
function poll(){
  fetch('/tracker/status/data').then(function(r){return r.json();}).then(function(d){
    if(d.lastSpot){
      var e=document.getElementById('d-spot'); if(e)e.textContent='₹'+d.lastSpot.toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2});
      var t=document.getElementById('d-spot-time'); if(t)t.textContent=d.lastSpotTime||'';
    }
    if(d.position){
      var dsl=document.getElementById('d-sl'); if(dsl)dsl.textContent='₹'+d.position.stopLoss.toLocaleString('en-IN',{minimumFractionDigits:2});
      var dc=document.getElementById('d-cushion');
      if(dc&&d.lastSpot){var g=d.position.side==='CE'?d.lastSpot-d.position.stopLoss:d.position.stopLoss-d.lastSpot;dc.textContent=g.toFixed(1)+' pt';dc.style.color=g<20?'#ef4444':'#f59e0b';}
      var dp=document.getElementById('d-pnl');
      if(dp&&d.unrealisedPts!==null){dp.textContent=(d.unrealisedPts>=0?'+':'')+d.unrealisedPts+' pt';dp.style.color=d.unrealisedPts>=0?'#10b981':'#ef4444';}
      var dt=document.getElementById('d-trail'),db=document.getElementById('d-best');
      if(dt){
        var mv=d.lastSpot?(d.position.side==='CE'?d.lastSpot-d.position.entrySpot:d.position.entrySpot-d.lastSpot):0;
        var be=mv>=(d.position.breakevenPts||25);
        dt.textContent=be?'🔒 Breakeven+':'Prev-candle '+(d.position.side==='CE'?'low':'high');dt.style.color=be?'#8b5cf6':'#f59e0b';
        if(db)db.textContent=d.position.bestPrice?'₹'+d.position.bestPrice:'—';
      }
    }
    if(d.logs)renderLogs(d.logs);
    if(!d.active&&(d.status==='sl_hit'||d.status==='exited')&&document.getElementById('fetch-btn'))
      setTimeout(function(){location.reload();},1500);
    if(!d.active&&!document.getElementById('fetch-btn')&&document.querySelector('[onclick*="handleExit"]'))
      setTimeout(function(){location.reload();},2000);
  }).catch(function(){});
}
setInterval(poll,1500);

async function handleFetch(btn){
  if(btn){btn.innerHTML='⏳ Fetching...';btn.disabled=true;}
  var msg=document.getElementById('fetch-msg');
  if(msg)msg.innerHTML='<span style="color:#4a6080;">Reading Zerodha position + computing SAR SL...</span>';
  try{
    var res=await fetch('/tracker/fetch-and-start');
    var data=await res.json();
    if(!data.success){
      if(msg)msg.innerHTML='<span style="color:#ef4444;">❌ '+(data.error||'Failed')+'</span>';
      if(btn){btn.innerHTML='📥 Fetch from Zerodha &amp; Start Tracking';btn.disabled=false;}
    } else {
      if(msg)msg.innerHTML='<span style="color:#10b981;">✅ '+data.message+'</span>';
      setTimeout(function(){location.reload();},1200);
    }
  }catch(e){
    if(msg)msg.innerHTML='<span style="color:#ef4444;">❌ '+e.message+'</span>';
    if(btn){btn.innerHTML='📥 Fetch from Zerodha &amp; Start Tracking';btn.disabled=false;}
  }
}
async function handleExit(btn){
  var ok=await showConfirm({icon:'🛑',title:'Stop Tracking',message:'Stop tracking?\\nClose your position in Zerodha too.',confirmText:'Stop',confirmClass:'modal-btn-danger'});
  if(!ok)return;
  if(btn){btn.textContent='⏳...';btn.disabled=true;}
  try{
    var res=await secretFetch('/tracker/exit');
    if(!res){if(btn){btn.textContent='🛑 Stop Tracking';btn.disabled=false;}return;}
    var data=await res.json();
    if(data.success)setTimeout(function(){location.reload();},1000);
    else{if(btn){btn.textContent='🛑 Stop Tracking';btn.disabled=false;}}
  }catch(e){if(btn){btn.textContent='🛑 Stop Tracking';btn.disabled=false;}}
}
</script>
</body>
</html>`;
  res.setHeader("Content-Type","text/html");
  return res.send(html);
});

module.exports = router;

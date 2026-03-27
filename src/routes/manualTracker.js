/**
 * manualTracker.js — Automatic Zerodha Position Tracker
 * ─────────────────────────────────────────────────────────────────────────────
 * Workflow:
 *   1. User takes entry in Zerodha manually
 *   2. Clicks "Fetch & Start Tracking" — zero manual input needed
 *   3. Bot reads open NIFTY position from Zerodha (symbol, qty, avg price)
 *   4. Fetches 15-min candles + runs SAR strategy → gets SAR as initial SL
 *   5. Polls NIFTY spot every 1 second via Fyers REST
 *   6. Trails SL with same tiered logic as paper/live trade
 *   7. Sends Telegram alert when SL is hit
 *   8. Marks position closed (user still exits in Zerodha manually)
 */

const express = require("express");
const router  = express.Router();
const fyers   = require("../config/fyers");
const { sendTelegram } = require("../utils/notify");
const { buildSidebar, sidebarCSS, toastJS } = require("../utils/sharedNav");
const sharedSocketState = require("../utils/sharedSocketState");

// Trail tier config (same as paper/live)
const _T1_UPTO    = parseFloat(process.env.TRAIL_TIER1_UPTO   || "40");
const _T2_UPTO    = parseFloat(process.env.TRAIL_TIER2_UPTO   || "70");
const _T1_GAP     = parseFloat(process.env.TRAIL_TIER1_GAP    || "60");
const _T2_GAP     = parseFloat(process.env.TRAIL_TIER2_GAP    || "40");
const _T3_GAP     = parseFloat(process.env.TRAIL_TIER3_GAP    || "30");
const _TRAIL_ACT  = parseFloat(process.env.TRAIL_ACTIVATE_PTS || "15");

function getDynamicTrailGap(m) {
  if (m < _T1_UPTO) return _T1_GAP;
  if (m < _T2_UPTO) return _T2_GAP;
  return _T3_GAP;
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
    if (result.stopLoss && typeof result.stopLoss === "number") {
      tlog(`✅ SAR SL: ₹${result.stopLoss} | Signal: ${result.signal}`);
      return parseFloat(result.stopLoss.toFixed(2));
    }
    tlog(`⚠️ SAR SL not available (${result.reason ? result.reason.slice(0,60) : "no reason"})`);
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
    const ACT = pos.trailActivatePts || _TRAIL_ACT;

    if (pos.side === "CE") {
      if (!pos.bestPrice || spot > pos.bestPrice) pos.bestPrice = spot;
      const move = pos.bestPrice - pos.entrySpot;
      if (move >= ACT) {
        const gap = getDynamicTrailGap(move);
        const trailSL = parseFloat((pos.bestPrice - gap).toFixed(2));
        const eff = pos.entryPrevMid !== null ? Math.max(trailSL, pos.entryPrevMid) : trailSL;
        if (eff > pos.stopLoss) {
          tlog(`📈 Trail CE [T${move<_T1_UPTO?1:move<_T2_UPTO?2:3} gap=${gap}pt]: best=₹${pos.bestPrice} (+${move.toFixed(1)}pt) SL ₹${pos.stopLoss}→₹${eff}`);
          pos.stopLoss = eff;
          sendTelegram(`📈 [TRACKER] Trail CE → SL ₹${eff}\nBest: ₹${pos.bestPrice} (+${move.toFixed(1)}pt)`);
        }
      }
      if (spot <= pos.stopLoss) {
        tlog(`🛑 SL HIT CE — spot ₹${spot} <= SL ₹${pos.stopLoss}`);
        sendTelegram(`🚨 [TRACKER] SL HIT — NIFTY ₹${spot} crossed below ₹${pos.stopLoss}\n⚡ Close your CE in Zerodha NOW!`);
        tracker.status = "sl_hit"; tracker.position = null; stopTracking();
      }
    } else {
      if (!pos.bestPrice || spot < pos.bestPrice) pos.bestPrice = spot;
      const move = pos.entrySpot - pos.bestPrice;
      if (move >= ACT) {
        const gap = getDynamicTrailGap(move);
        const trailSL = parseFloat((pos.bestPrice + gap).toFixed(2));
        const eff = pos.entryPrevMid !== null ? Math.min(trailSL, pos.entryPrevMid) : trailSL;
        if (eff < pos.stopLoss) {
          tlog(`📉 Trail PE [T${move<_T1_UPTO?1:move<_T2_UPTO?2:3} gap=${gap}pt]: best=₹${pos.bestPrice} (+${move.toFixed(1)}pt) SL ₹${pos.stopLoss}→₹${eff}`);
          pos.stopLoss = eff;
          sendTelegram(`📉 [TRACKER] Trail PE → SL ₹${eff}\nBest: ₹${pos.bestPrice} (+${move.toFixed(1)}pt)`);
        }
      }
      if (spot >= pos.stopLoss) {
        tlog(`🛑 SL HIT PE — spot ₹${spot} >= SL ₹${pos.stopLoss}`);
        sendTelegram(`🚨 [TRACKER] SL HIT — NIFTY ₹${spot} crossed above ₹${pos.stopLoss}\n⚡ Close your PE in Zerodha NOW!`);
        tracker.status = "sl_hit"; tracker.position = null; stopTracking();
      }
    }
  } finally { tracker.pollBusy = false; }
}

function startTracking() {
  stopTracking(); tracker.pollBusy = false; tracker.status = "tracking";
  function next() {
    if (!tracker.pollTimer) return;
    tracker.pollTimer = setTimeout(async () => { await trackerTick(); next(); }, 1000);
  }
  tracker.pollTimer = true;
  trackerTick().then(next);
  tlog("📡 Tracking started — polling NIFTY every 1s");
}
function stopTracking() {
  if (tracker.pollTimer && tracker.pollTimer !== true) clearTimeout(tracker.pollTimer);
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
    const trailActivatePts = Math.min(40, Math.max(_TRAIL_ACT, Math.round(sarGap * 0.25)));

    tracker.position = {
      side, symbol: sym, strike, expiry, qty,
      entrySpot: spot, stopLoss: sl, initialStopLoss: sl,
      optionLtp, entryPrevMid: null,
      trailActivatePts, bestPrice: null, entryTime: istNow(), sarGap,
    };

    tlog(`✅ TRACKING: ${side} ${sym} | spot=₹${spot} | SL=₹${sl} (${sarGap.toFixed(1)}pt) | trail at +${trailActivatePts}pt`);
    sendTelegram([
      `🎯 [TRACKER] Auto-tracking started`,
      ``, `${side === "CE" ? "📈 CE (Call — Bullish)" : "📉 PE (Put — Bearish)"}`,
      `Symbol  : ${sym}`,
      `Strike  : ${strike || "—"} | Expiry: ${expiry || "—"}`,
      `Qty     : ${qty}`,
      ``,
      `NIFTY Spot : ₹${spot}`,
      `SAR SL     : ₹${sl}  (${sarGap.toFixed(1)}pt gap)`,
      `Trail at   : +${trailActivatePts}pt`,
      `Opt Avg LTP: ${optionLtp ? "₹" + optionLtp : "—"}`,
    ].join("\n"));

    startTracking();
    return res.json({ success: true, message: `Tracking ${side} ${sym} | SL ₹${sl} | Trail at +${trailActivatePts}pt`, position: tracker.position });
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
      optionLtp: pos.optionLtp, trailActivatePts: pos.trailActivatePts, bestPrice: pos.bestPrice,
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
  const move = pos && pos.bestPrice ? (pos.side === "CE" ? pos.bestPrice - pos.entrySpot : pos.entrySpot - pos.bestPrice) : 0;
  const trailActive = move >= (pos ? pos.trailActivatePts : _TRAIL_ACT);
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
  <title>Trade Tracker</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;600&display=swap" rel="stylesheet"/>
  <style>
    *{box-sizing:border-box;margin:0;padding:0;}
    body{font-family:'Inter',sans-serif;background:#040c18;color:#e0eaf8;overflow-x:hidden;}
    ${sidebarCSS()}
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
${buildSidebar("tracker", sharedSocketState.getMode()==="LIVE_TRADE", !!pos, {
  showExitBtn: !!pos, exitBtnJs: "handleExit(this)", exitLabel: "🛑 Stop Tracking",
  statusLabel: pos ? "TRACKING" : tracker.status === "sl_hit" ? "SL HIT" : "IDLE",
})}
<div class="main-content">
  <div class="top-bar">
    <div>
      <div class="top-bar-title">🎯 Auto Trade Tracker</div>
      <div class="top-bar-meta">Reads your Zerodha entry → SAR Stop Loss → trails automatically</div>
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
        Bot will read your open NIFTY position from Zerodha, compute the current SAR value as your Stop Loss, then trail it automatically using the same tiered logic as the live trade engine.
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
      <div class="sc" style="--accent:${trailActive?"#4c1d95":"#1e3080"};">
        <div class="sc-label">Trail SL</div>
        <div class="sc-val" id="d-trail" style="color:${trailActive?"#8b5cf6":"#f59e0b"};">${trailActive?"🔒 ACTIVE":"⏳ Waiting"}</div>
        <div class="sc-sub">Best: <span id="d-best">${pos.bestPrice?"₹"+pos.bestPrice:"—"}</span> | +${pos.trailActivatePts}pt to activate</div>
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
      if(dt&&d.position.bestPrice){
        var mv=d.position.side==='CE'?d.position.bestPrice-d.position.entrySpot:d.position.entrySpot-d.position.bestPrice;
        var act=mv>=(d.position.trailActivatePts||15);
        dt.textContent=act?'🔒 ACTIVE':'⏳ Waiting';dt.style.color=act?'#8b5cf6':'#f59e0b';
        if(db)db.textContent='₹'+d.position.bestPrice;
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
  if(!confirm('Stop tracking?\\nClose your position in Zerodha too.'))return;
  if(btn){btn.textContent='⏳...';btn.disabled=true;}
  try{
    var res=await fetch('/tracker/exit');var data=await res.json();
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
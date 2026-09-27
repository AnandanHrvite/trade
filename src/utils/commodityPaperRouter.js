/**
 * commodityPaperRouter.js — the Paper page for a COMMODITY engine
 * (src/services/commodityPaper.js). One builder, used by every
 * /cmx_{crude,gold,silver}_{ema_rsi_st,ema_rsi_st_v2}-paper page.
 *
 *   GET /status           the page
 *   GET /status/fragment  the live part of the page (polled every 4 s)
 *   GET /status/data      JSON snapshot
 *   GET /start · /stop · /exit · /reset
 */

const express = require("express");
const { buildSidebar, sidebarCSS, faviconLink, modalCSS } = require("./sharedNav");
const { bbRsiStyleCSS, bbRsiTopBar, bbRsiStatGrid } = require("./bbRsiStyleUI");

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function rs(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  return (n < 0 ? "-₹" : "₹") + Math.abs(n).toLocaleString("en-IN", { maximumFractionDigits: 2 });
}
function pnlColor(n) { return n > 0 ? "#10b981" : n < 0 ? "#ef4444" : "#94a3b8"; }
function hhmm(iso) {
  if (!iso) return "—";
  return new Date(new Date(iso).getTime() + 19800000).toISOString().slice(11, 16);
}
function fmtMins(m) { return String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0"); }

function createCommodityPaperRouter({ engine, base, navKey, title, icon, rulesText }) {
  const router = express.Router();
  const modeKey = () => engine.snapshot().modeKey;
  const modeOn  = () => String(process.env[modeKey()] || "false").toLowerCase() === "true";

  function liveFragment(s) {
    const c = s.cfg;
    const wins = s.trades.filter((t) => t.pnl > 0).length;
    const losses = s.trades.filter((t) => t.pnl < 0).length;
    const p = s.position;
    const unreal = p && s.optLtp ? Math.round((s.optLtp - p.optionEntryLtp) * p.multiplier * p.lots * 100) / 100 : null;
    const priceAge = s.lastQuoteAt ? Math.round((Date.now() - s.lastQuoteAt) / 1000) : null;

    const stats = bbRsiStatGrid([
      { label: "Today P&L", value: rs(s.sessionPnl), color: pnlColor(s.sessionPnl) },
      { label: "Trades", value: `${s.trades.length} / ${c.maxTrades}` },
      { label: "Win / Loss", value: `${wins} / ${losses}` },
      { label: `${s.underlying.label} future`, value: s.futLtp != null ? String(s.futLtp) : "—", sub: priceAge != null ? `${priceAge}s ago` : "" },
      { label: "Last signal", value: s.lastSignal ? esc(s.lastSignal.signal || "NONE") : "—", sub: s.lastSignal ? `candle ${hhmm(new Date(s.lastSignal.at * 1000).toISOString())} · close ${s.lastSignal.close}` : "" },
      { label: "All-time P&L", value: rs(s.allTime), color: pnlColor(s.allTime) },
    ]);

    const posCard = p ? `
<div class="cx-card cx-pos">
  <div class="cx-h">Open trade</div>
  <div class="cx-row">
    <div><span class="k">Bought</span><span class="cx-pill ${p.side === "CE" ? "cx-ce" : "cx-pe"}">${p.side}</span> ${esc(p.symbol)}</div>
    <div><span class="k">Lots</span>${p.lots}</div>
    <div><span class="k">Entry</span>₹${p.optionEntryLtp} at ${hhmm(p.entryTime)}</div>
    <div><span class="k">Now</span>${s.optLtp != null ? "₹" + s.optLtp : "—"}</div>
    <div><span class="k">Open P&L</span><b style="color:${pnlColor(unreal || 0)}">${rs(unreal)}</b></div>
    <div><span class="k">Future at entry</span>${p.spotAtEntry}</div>
    <div><span class="k">Stop (future)</span>${p.stopLoss != null ? p.stopLoss : "—"}</div>
    <div><span class="k">Candles held</span>${p.candlesHeld}</div>
  </div>
  <div style="margin-top:10px;"><a class="cx-btn cx-red" href="${base}/exit" onclick="return confirm('Exit this paper trade now?')">Exit now</a></div>
</div>` : "";

    const armed = s.armed ? `<div class="cx-note">🎯 ${s.armed.side} signal armed — enters if the future crosses ${s.armed.triggerLevel} during this candle.</div>` : "";
    const halted = s.halted ? `<div class="cx-note cx-warn">⏸️ ${esc(s.halted)}</div>` : "";
    const err = s.lastError ? `<div class="cx-note cx-warn">⚠️ ${esc(s.lastError)}</div>` : "";

    const tradeRows = s.trades.slice().reverse().map((t) => `
<tr><td>${hhmm(t.entryTime)}–${hhmm(t.exitTime)}</td><td><span class="cx-pill ${t.side === "CE" ? "cx-ce" : "cx-pe"}">${t.side}</span> ${t.strike}</td>
<td>₹${t.optionEntryLtp} → ₹${t.optionExitLtp}</td><td style="color:${pnlColor(t.pnl)}"><b>${rs(t.pnl)}</b></td><td class="cx-reason">${esc(t.exitReason)}</td></tr>`).join("");

    const histRows = s.history.map((d) => `<tr><td>${d.day}</td><td>${d.trades}</td><td style="color:${pnlColor(d.pnl)}">${rs(d.pnl)}</td></tr>`).join("");

    return `
${stats}
${halted}${err}${armed}
${posCard}
<div class="cx-card">
  <div class="cx-h">Today's trades</div>
  ${s.trades.length ? `<div class="cx-scroll"><table class="cx-t"><thead><tr><th>Time</th><th>Option</th><th>Premium</th><th>P&L</th><th>Why it closed</th></tr></thead><tbody>${tradeRows}</tbody></table></div>`
    : `<div class="cx-muted">No trades yet today.</div>`}
</div>
<div class="cx-card">
  <div class="cx-h">Past days</div>
  ${s.history.length ? `<div class="cx-scroll"><table class="cx-t"><thead><tr><th>Day</th><th>Trades</th><th>P&L</th></tr></thead><tbody>${histRows}</tbody></table></div>`
    : `<div class="cx-muted">No history yet.</div>`}
</div>
<div class="cx-card">
  <div class="cx-h">Activity log</div>
  <pre class="cx-log">${s.logs.length ? s.logs.slice().reverse().map(esc).join("\n") : "Nothing yet — press Start."}</pre>
</div>`;
  }

  router.get("/status/data", (req, res) => res.json(engine.snapshot()));
  router.get("/status/fragment", (req, res) => res.type("html").send(liveFragment(engine.snapshot())));

  router.get("/status", (req, res) => {
    const s = engine.snapshot();
    const c = s.cfg;
    const msg = req.query.msg ? `<div class="cx-note cx-warn">${esc(req.query.msg)}</div>` : "";
    const off = modeOn() ? "" : `<div class="cx-note cx-warn">This strategy is switched off. Turn on <b>${modeKey()}</b> in Settings → Menu Visibility to start it.</div>`;
    const contract = s.series
      ? `Signal from <b>${esc(s.series.future)}</b> (expires ${s.series.futureExpiry}) · buys options expiring <b>${s.series.optionExpiry}</b>`
      : `The contract is picked when you press Start: ${esc(s.underlying.label)}, nearest option expiry after today.`;

    res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"/>
<title>${esc(title)} — Paper</title>${faviconLink()}
<style>${sidebarCSS()}${modalCSS()}${bbRsiStyleCSS()}
.cx-card{background:#0a1020;border:1px solid #1a2236;border-radius:10px;padding:14px 16px;margin-bottom:16px;}
.cx-h{font-size:0.7rem;color:var(--muted-1,#8ba1c2);text-transform:uppercase;letter-spacing:0.05em;font-weight:600;margin-bottom:8px;}
.cx-row{display:flex;gap:10px 22px;flex-wrap:wrap;font-size:0.8rem;color:#e2e8f0;}
.cx-row .k{color:var(--muted-1,#8ba1c2);margin-right:6px;}
.cx-pill{display:inline-block;padding:2px 8px;border-radius:999px;font-size:0.7rem;font-weight:700;}
.cx-ce{background:rgba(16,185,129,0.15);color:#10b981;} .cx-pe{background:rgba(239,68,68,0.15);color:#ef4444;}
.cx-pos{border-color:rgba(59,130,246,0.45);}
.cx-note{font-size:0.78rem;color:#cbd5e1;background:rgba(59,130,246,0.08);border:1px solid rgba(59,130,246,0.25);border-radius:8px;padding:9px 12px;margin-bottom:14px;}
.cx-warn{background:rgba(245,158,11,0.08);border-color:rgba(245,158,11,0.3);color:#fcd34d;}
.cx-muted{font-size:0.78rem;color:var(--muted-1,#8ba1c2);}
.cx-scroll{overflow-x:auto;-webkit-overflow-scrolling:touch;}
.cx-t{width:100%;border-collapse:collapse;font-size:0.76rem;color:#e2e8f0;min-width:520px;}
.cx-t th{text-align:left;color:var(--muted-1,#8ba1c2);font-weight:600;padding:6px 8px;border-bottom:1px solid #1a2236;white-space:nowrap;}
.cx-t td{padding:7px 8px;border-bottom:1px solid #111a2c;white-space:nowrap;}
.cx-t td.cx-reason{white-space:normal;min-width:180px;color:#94a3b8;}
.cx-log{font-size:0.7rem;line-height:1.55;color:#94a3b8;max-height:320px;overflow:auto;white-space:pre-wrap;word-break:break-word;margin:0;}
.cx-btn{display:inline-flex;align-items:center;min-height:44px;padding:0 16px;border-radius:8px;font-size:0.78rem;font-weight:700;text-decoration:none;}
.cx-red{background:#7f1d1d;border:1px solid #ef4444;color:#fca5a5;}
.rule-list{margin:8px 0 0;padding-left:18px;color:var(--muted-1,#8ba1c2);font-size:0.75rem;line-height:1.7;}
.rule-list b{color:#cbd5e1;font-weight:600;}
@media (max-width:640px){ .cx-card{padding:12px;} .cx-row{font-size:0.76rem;gap:8px 14px;} }
</style></head><body>
${buildSidebar(navKey, false, s.running)}
<div class="main-content">
${bbRsiTopBar({
  title: `${icon} ${title} — Paper`,
  metaLine: `${esc(s.underlying.label)} (MCX) · ${c.res}m candles · entries ${fmtMins(c.entryStart)}–${fmtMins(c.entryEnd)} · exit ${fmtMins(c.eodExit)} · ${c.lots} lot`,
  running: s.running,
  primaryAction: modeOn() ? { href: `${base}/start`, label: "▶ Start", color: "#0369a1" } : null,
  stopAction: { href: `${base}/stop`, label: "■ Stop" },
  resetJs: s.running ? null : `if(confirm('Wipe all ${esc(title)} paper history?'))location='${base}/reset'`,
})}
${msg}${off}
<div class="cx-card">
  <div class="cx-h">How it trades</div>
  <div class="cx-muted">${contract}</div>
  <ul class="rule-list">${rulesText}
    <li><b>Buys</b> the at-the-money ${esc(s.underlying.label)} option, ${c.lots} lot (1 lot = ${esc(s.underlying.unit)}). P&L = premium change × ${s.underlying.multiplier} per lot − ₹${c.charges} charges.</li>
    <li><b>Day guards:</b> max ${c.maxTrades} trades, stop for the day at −₹${c.maxLoss} — for this page alone. Paper only — no real orders, and separate from all NIFTY strategies.</li>
  </ul>
</div>
<div id="cx-live">${liveFragment(s)}</div>
</div>
<script>
(function(){
  var box=document.getElementById('cx-live');
  function tick(){
    if(document.hidden) return;
    fetch('${base}/status/fragment',{cache:'no-store'}).then(function(r){return r.ok?r.text():null}).then(function(h){ if(h!=null) box.innerHTML=h; }).catch(function(){});
  }
  setInterval(tick,4000);
})();
</script>
</body></html>`);
  });

  router.get("/start", async (req, res) => {
    if (!modeOn()) return res.redirect(`${base}/status?msg=` + encodeURIComponent(`Switched off — turn on ${modeKey()} in Settings first.`));
    const r = await engine.start();
    res.redirect(`${base}/status` + (r.ok ? "" : "?msg=" + encodeURIComponent("Not started: " + r.reason)));
  });
  router.get("/stop", async (req, res) => { await engine.stop("manual stop"); res.redirect(`${base}/status`); });
  router.get("/exit", async (req, res) => { await engine.manualExit(); res.redirect(`${base}/status`); });
  router.get("/reset", (req, res) => {
    const r = engine.reset();
    // Settings → Reset Paper calls every engine's /reset in-process and reads a
    // 400 as "skipped because it is running".
    if (req.headers && req.headers["x-paper-reset"]) {
      return r.ok ? res.json({ success: true, message: `${title} history cleared` })
                  : res.status(400).json({ success: false, error: `Stop ${title} paper trading first before resetting.` });
    }
    res.redirect(`${base}/status` + (r.ok ? "" : "?msg=" + encodeURIComponent(r.reason)));
  });
  router.get("/", (req, res) => res.redirect(`${base}/status`));

  return router;
}

const RULES = {
  V1: `
    <li><b>Signal:</b> the EMA_RSI_ST rules — EMA20/50 trend + RSI + SuperTrend on the future, using the same settings as the NIFTY EMA_RSI_ST.</li>
    <li><b>Entry:</b> with the confirmation candle on, the next candle must cross the signal candle's close.</li>
    <li><b>Exits:</b> previous-candle stop trailed on EMA21, EMA21 touch-back, negative-candle stop, option stop %, profit lock / breakeven, opposite signal, and the day's exit time.</li>`,
  V2: `
    <li><b>Signal:</b> the EMA_RSI_ST_V2 rules — EMA20 vs EMA50 + close beyond EMA20 + RSI on the future, using the same settings as the NIFTY EMA_RSI_ST_V2.</li>
    <li><b>Entry:</b> with the confirmation candle on, the next candle must cross the signal candle's close.</li>
    <li><b>Exits:</b> SuperTrend trailing stop (its only stop), profit lock, opposite signal, and the day's exit time.</li>`,
};
const ICONS = { CRUDE: "🛢️", GOLD: "🥇", SILVER: "🥈" };

/**
 * One commodity × strategy Paper page. Everything is derived from the pair:
 *   ("GOLD", "V2") → /cmx_gold_ema_rsi_st_v2-paper, toggle
 *   CMX_GOLD_EMA_RSI_ST_V2_MODE_ENABLED, settings CMX_EMA_RSI_ST_V2_*.
 */
function commodityPage({ commodity, strategy }) {
  const { createEngine } = require("../services/commodityPaper");
  const { COMMODITIES } = require("../services/mcxContracts");
  const strat = strategy === "V2" ? "EMA_RSI_ST_V2" : "EMA_RSI_ST";
  const id = `cmx_${commodity.toLowerCase()}_${strat.toLowerCase()}`;
  const camel = commodity.charAt(0) + commodity.slice(1).toLowerCase();
  const engine = createEngine({
    id, commodity, strategy,
    prefix:  `CMX_${strat}`,
    modeKey: `CMX_${commodity}_${strat}_MODE_ENABLED`,
    label:   `${strat} (${COMMODITIES[commodity].label})`,
  });
  const router = createCommodityPaperRouter({
    engine,
    base:   `/${id}-paper`,
    navKey: `cmx${camel}${strategy === "V2" ? "EmaRsiStV2" : "EmaRsiSt"}Paper`,
    title:  `${strat} · ${COMMODITIES[commodity].label}`,
    icon:   ICONS[commodity],
    rulesText: RULES[strategy],
  });
  router.engine = engine;
  return router;
}

module.exports = { createCommodityPaperRouter, commodityPage };

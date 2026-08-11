/**
 * oiMonitor.js — LIVE PER-STRIKE OPEN INTEREST (read-only)
 * ─────────────────────────────────────────────────────────────────────────────
 * GET /oi-monitor        → the page
 * GET /oi-monitor/data   → JSON snapshot (polled by the page every few seconds)
 *
 * WHY THIS PAGE EXISTS
 * ────────────────────
 * The gap in this platform is the SIDEWAYS DAY. Every engine here — EMA_RSI_ST,
 * BB_RSI, PA, ORB, Trend_PB, EMA9_VWAP, TDS, GAP3M — is a trend or breakout
 * strategy, and on a range day they either sit flat or bleed on whipsaws. Adding
 * a ninth momentum strategy would just add correlated risk.
 *
 * Per-strike Open Interest is the one input that speaks to a range, because in a
 * range the levels are not drawn by price — they are set by WHERE THE WRITERS
 * ARE. Every indicator in this repo (EMA, BB, VWAP, SuperTrend, ATR) is derived
 * from price and therefore says nothing new. OI is genuinely different
 * information, and this repo has never had it at strike level.
 *
 * It also cannot be backtested: Fyers offers no historical-OI API, so the only
 * way to research it is to record forward. Hence this page, which answers — with
 * our own data, before any engine is written:
 *
 *   • Do the walls actually hold price, or does it cut straight through them?
 *   • How far does a rejection off a defended wall actually travel? (If the
 *     answer is "20 points" the whole idea dies to theta and cost, and it is far
 *     cheaper to learn that here than from a live P&L curve.)
 *   • How big is a real ΔOI move versus the noise floor?
 *
 * READ-ONLY by construction: no position, no order, no strategy state, not wired
 * into positionPersist / sharedSocketState / capitalPool. It reads the in-memory
 * oiChain series that optionChainRecorder already fills, and nothing else.
 *
 * THE OBSERVATION LOG
 * ───────────────────
 * Three things are logged — never traded — so a session leaves behind a
 * reviewable list instead of a vague impression:
 *
 *   DEFEND  price pressing a max-OI wall whose OI is still RISING.
 *           Writers are holding the line → the fade candidate.
 *   BREAK   price at/through that wall while its OI FALLS.
 *           Writers are running → the ANTI-signal. Stand aside; this is the
 *           setup that turns a fade into a trend loss, and it is logged so the
 *           two can be told apart in review rather than lumped together.
 *   RANGE   whether spot is contained between the two walls, and how wide that
 *           band is. A fade only makes sense inside a band wide enough to pay
 *           for the round trip — this is the regime gate, recorded per poll.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const express = require("express");
const router  = express.Router();

const oiChain             = require("../services/oiChain");
const optionChainRecorder = require("../utils/optionChainRecorder");
const sharedSocketState   = require("../utils/sharedSocketState");
const { buildSidebar, sidebarCSS, faviconLink, modalCSS, modalJS } = require("../utils/sharedNav");

// Lookbacks are in OI MOVES, not polls or minutes — see oiChain's header.
const LOOKBACKS = [1, 3, 6];

// Thresholds for the observation log ONLY. They exist to keep the log readable,
// not to define a strategy — a real entry rule has to be derived from the data
// this page collects, not asserted before collecting it.
const WALL_NEAR_PTS  = 30;   // spot within this many points of the wall strike
const WALL_BUILD_PCT = 2;    // wall OI still adding over 3 moves → defended
const WALL_SHED_PCT  = -2;   // wall OI shedding over 3 moves → breaking, stand aside

// Rolling observation log, newest first. Bounded — this page can be left open all
// day and must not grow without limit.
const MAX_CANDIDATES = 200;
const _candidates = [];
let _lastFingerprint = "";

function _istHhMm(ts) {
  const istSec = Math.floor((ts || Date.now()) / 1000) + 19800;
  const d = new Date(istSec * 1000);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}:${String(d.getUTCSeconds()).padStart(2, "0")}`;
}

const _d3 = (cell) => (cell && cell.deltas && cell.deltas[3] ? cell.deltas[3].pct : null);

/**
 * The regime gate for a fade: is spot actually contained between the two walls,
 * and is that band wide enough for a round trip to be worth taking?
 *
 * `bandPts` is the honest constraint on the whole idea. If the walls sit 60
 * points apart, a fade from one to the other cannot pay for the spread plus the
 * theta burnt waiting — no threshold tuning fixes that. Recorded per poll so the
 * distribution of band widths can be reviewed rather than assumed.
 */
function _rangeState(snap) {
  const { ce, pe } = snap.walls;
  if (!ce || !pe || !(snap.spot > 0)) return { inBand: null, bandPts: null };
  const lo = Math.min(ce.strike, pe.strike);
  const hi = Math.max(ce.strike, pe.strike);
  return {
    inBand:  snap.spot >= lo && snap.spot <= hi,
    bandPts: hi - lo,
    lo, hi,
  };
}

/**
 * Scan a snapshot and append anything new to the observation log.
 * Pure observation — returns nothing, changes no strategy state.
 *
 * De-duplicated on a coarse fingerprint so a 5s poll cannot write the same
 * observation forty times while one setup persists.
 */
function _collectCandidates(snap) {
  if (!snap || !(snap.spot > 0) || !snap.rows.length) return;
  const now = Date.now();
  const rowAt = (strike) => snap.rows.find((r) => r.strike === strike) || null;
  const found = [];
  const range = _rangeState(snap);
  const { ce, pe, atBandEdge } = snap.walls;
  const edge = atBandEdge ? " ⚠ wall at band edge" : "";
  const band = range.bandPts != null ? ` [band ${range.bandPts}pt]` : "";

  // A wall is only interesting when price is actually pressing it. Both the fade
  // and its anti-signal start here; what separates them is the DIRECTION of the
  // wall's own OI — defended (fade) versus shedding (real break, stand aside).
  const check = (wall, side, fadeSide) => {
    if (!wall || Math.abs(snap.spot - wall.strike) > WALL_NEAR_PTS) return;
    const d = _d3((rowAt(wall.strike) || {})[side]);
    if (d == null) return;
    const at = `spot ${snap.spot.toFixed(0)} at ${side} wall ${wall.strike}`;

    if (d >= WALL_BUILD_PCT) {
      found.push({ kind: "DEFEND", side: fadeSide, strike: wall.strike,
        note: `${at}, wall ΔOI +${d.toFixed(1)}% — writers defending${band}${edge}` +
              (range.inBand === false ? " ⚠ spot outside wall band" : "") });
    } else if (d <= WALL_SHED_PCT) {
      found.push({ kind: "BREAK", side: fadeSide === "CE" ? "PE" : "CE", strike: wall.strike,
        note: `${at}, wall ΔOI ${d.toFixed(1)}% — writers running, do NOT fade${band}${edge}` });
    }
  };

  // CE wall = resistance → the fade is a PE. PE wall = support → the fade is a CE.
  check(ce, "CE", "PE");
  check(pe, "PE", "CE");

  if (!found.length) { _lastFingerprint = ""; return; }

  const fp = found.map((f) => `${f.kind}${f.side}${f.strike}`).join(",");
  if (fp === _lastFingerprint) return;   // same setup still standing — already logged
  _lastFingerprint = fp;

  for (const f of found) {
    _candidates.unshift({ t: now, time: _istHhMm(now), spot: Math.round(snap.spot), ...f });
  }
  if (_candidates.length > MAX_CANDIDATES) _candidates.length = MAX_CANDIDATES;
}

/**
 * Say plainly why the ladder is empty rather than rendering a blank table. Each
 * of these is a real, distinct cause with a different fix, and guessing between
 * them wastes a trading day.
 */
function _emptyReason(stats, snap) {
  if (snap.strikeCount > 0) return null;
  if (!stats.enabled)      return "Chain recorder is off — enable OPTION_CHAIN_RECORDER_ENABLED (and TICK_RECORDER_ENABLED) in Settings.";
  if (!stats.oiEnabled)    return "Per-strike OI capture is off — enable OPTION_CHAIN_RECORD_OI in Settings.";
  if (!stats.marketHours)  return "Outside market hours (09:15–15:20 IST). OI is frozen; the ladder fills on the next session.";
  if (stats.lastSpot == null) return "No spot tick yet — waiting for the Fyers socket.";
  if (stats.failStreak > 0)   return `Chain polls are failing (${stats.failStreak}× in a row) — usually an expired Fyers token. Re-login.`;
  return "Waiting for the first chain poll…";
}

// ── JSON snapshot ────────────────────────────────────────────────────────────
router.get("/data", (req, res) => {
  try {
    const stats = optionChainRecorder.getStats();
    const snap  = oiChain.snapshot({ spot: stats.lastSpot, lookbacks: LOOKBACKS });
    _collectCandidates(snap);
    res.json({
      ok: true,
      recorder: stats,
      snapshot: snap,
      range: _rangeState(snap),
      candidates: _candidates.slice(0, 60),
      emptyReason: _emptyReason(stats, snap),
      serverTime: _istHhMm(Date.now()),
    });
  } catch (err) {
    console.warn(`[oiMonitor] /data failed: ${err.message}`);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Page ─────────────────────────────────────────────────────────────────────
router.get("/", (req, res) => {
  const liveActive = sharedSocketState.getMode() === "EMA_RSI_ST_LIVE";
  res.setHeader("Content-Type", "text/html");
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
  ${faviconLink()}
  <title>OI Monitor — Trading BOT</title>
  <style>
    *, *::before, *::after { box-sizing:border-box; margin:0; padding:0; }
    html, body { height:100%; }
    body { font-family:'IBM Plex Sans',sans-serif; background:#080c14; color:#c8d8f0; }
    ${sidebarCSS()}
    ${modalCSS()}

    .wrap { padding:16px 20px 40px; max-width:1180px; }
    h1 { font-size:1.05rem; font-weight:700; letter-spacing:0.2px; margin-bottom:2px; }
    .sub { font-size:0.72rem; color:#6d85a8; margin-bottom:14px; line-height:1.5; }
    .sub b { color:#8ba1c2; font-weight:600; }

    .banner { background:#1a1200; border:1px solid #403000; color:#fbbf24; font-size:0.72rem;
              padding:9px 13px; border-radius:6px; margin-bottom:14px; line-height:1.5; }
    .banner.hide { display:none; }

    .strip { display:flex; gap:10px; flex-wrap:wrap; margin-bottom:16px; }
    .stat { background:#0d1320; border:1px solid #1a2236; border-radius:7px; padding:9px 14px; min-width:120px; }
    .stat .k { font-size:0.58rem; text-transform:uppercase; letter-spacing:0.7px; color:#6d85a8; margin-bottom:3px; }
    .stat .v { font-size:0.95rem; font-weight:700; font-family:'IBM Plex Mono',monospace; }
    .v.ce { color:#f87171; } .v.pe { color:#34d399; } .v.neutral { color:#c8d8f0; }

    table { width:100%; border-collapse:collapse; font-family:'IBM Plex Mono',monospace; font-size:0.72rem; }
    th { background:#0d1320; color:#6d85a8; font-size:0.58rem; text-transform:uppercase; letter-spacing:0.6px;
         font-weight:600; padding:7px 9px; text-align:right; border-bottom:1px solid #1a2236; white-space:nowrap; }
    th.l, td.l { text-align:left; }
    th.c, td.c { text-align:center; }
    td { padding:6px 9px; text-align:right; border-bottom:1px solid #121a2a; white-space:nowrap; }
    tr.atm td { background:#0d1526; }
    tr.atm td.strike { color:#60a5fa; font-weight:700; }
    td.strike { font-weight:600; }
    .wall-ce { box-shadow:inset 3px 0 0 #f87171; }
    .wall-pe { box-shadow:inset -3px 0 0 #34d399; }
    .up { color:#34d399; } .down { color:#f87171; } .flat { color:#4a5b75; }
    .dim { color:#4a5b75; }
    .sect { font-size:0.62rem; text-transform:uppercase; letter-spacing:0.8px; color:#6d85a8;
            font-weight:700; margin:22px 0 8px; }

    .cand { background:#0d1320; border:1px solid #1a2236; border-radius:7px; max-height:280px; overflow-y:auto; }
    .cand .row { display:flex; gap:10px; align-items:baseline; padding:6px 12px; border-bottom:1px solid #121a2a;
                 font-family:'IBM Plex Mono',monospace; font-size:0.68rem; }
    .cand .row:last-child { border-bottom:none; }
    .cand .t { color:#6d85a8; flex-shrink:0; }
    .tag { font-size:0.55rem; font-weight:700; padding:2px 6px; border-radius:3px; letter-spacing:0.5px; flex-shrink:0; }
    .tag.DEFEND { background:#1a0f20; border:1px solid #3a2050; color:#c084fc; }
    .tag.BREAK  { background:#1a1200; border:1px solid #403000; color:#fbbf24; }
    .tag.CE { background:#200708; border:1px solid #401018; color:#f87171; }
    .tag.PE { background:#062014; border:1px solid #0e4020; color:#34d399; }
    .cand .n { color:#8ba1c2; }
    .empty { padding:16px; color:#4a5b75; font-size:0.72rem; text-align:center; }
  </style>
</head>
<body>
${buildSidebar('oi-monitor', liveActive)}
<div class="main">
  <div class="wrap">
    <h1>OI Monitor <span class="dim" style="font-size:0.7rem;font-weight:400;">read-only</span></h1>
    <div class="sub">
      Live per-strike Open Interest across the ATM±N ladder the chain recorder polls.
      <b>This page places no orders and runs no strategy</b> — it exists to collect evidence for a
      <b>range-day wall-fade</b> before any engine is written. Δ columns are percent change over the last
      <b>1 / 3 / 6 actual OI moves</b> (not polls, not minutes) — a quiet afternoon's "3 moves" can span far
      more wall-clock than a busy morning's, so read the tooltip.<br>
      <b>DEFEND</b> = price pressing a wall whose OI is still rising (writers holding → fade candidate).
      <b>BREAK</b> = price at that wall while its OI falls (writers running → stand aside, this is what turns
      a fade into a trend loss).
    </div>

    <div id="banner" class="banner hide"></div>

    <div class="strip" id="strip"></div>

    <div class="sect">Strike ladder</div>
    <table>
      <thead>
        <tr>
          <th class="l">CE OI</th><th>Δ1</th><th>Δ3</th><th>Δ6</th>
          <th class="c">Strike</th>
          <th>Δ6</th><th>Δ3</th><th>Δ1</th><th style="text-align:right">PE OI</th>
        </tr>
      </thead>
      <tbody id="ladder"><tr><td colspan="9" class="empty">loading…</td></tr></tbody>
    </table>

    <div class="sect">Observations <span class="dim" style="text-transform:none;letter-spacing:0;font-weight:400;">— logged, never traded</span></div>
    <div class="cand" id="cands"><div class="empty">nothing yet</div></div>
  </div>
</div>
${modalJS()}
<script>
  var LB = ${JSON.stringify(LOOKBACKS)};
  function nfmt(v){ return v==null ? '—' : Number(v).toLocaleString('en-IN'); }
  function dcell(d){
    if (!d || d.pct==null) return '<td class="dim">—</td>';
    var p = d.pct, cls = Math.abs(p) < 0.05 ? 'flat' : (p > 0 ? 'up' : 'down');
    var mins = d.spanMs ? Math.round(d.spanMs/60000) : 0;
    return '<td class="'+cls+'" title="over '+(mins||'<1')+'m">'+(p>0?'+':'')+p.toFixed(1)+'%</td>';
  }
  function esc(s){ return String(s).replace(/[&<>"]/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); }

  function render(d){
    var b = document.getElementById('banner');
    if (d.emptyReason) { b.textContent = d.emptyReason; b.classList.remove('hide'); }
    else b.classList.add('hide');

    var s = d.snapshot, w = s.walls || {}, p = s.pcr || {}, rg = d.range || {};
    var strip = [
      ['Spot', s.spot==null ? '—' : Math.round(s.spot), 'neutral'],
      ['ATM',  s.atm==null ? '—' : s.atm, 'neutral'],
      ['CE wall (resistance)', w.ce ? w.ce.strike : '—', 'ce'],
      ['PE wall (support)',    w.pe ? w.pe.strike : '—', 'pe'],
      // The regime gate: a fade only makes sense inside the walls, and only if the
      // band is wide enough that the round trip can pay for spread + theta.
      ['Wall band', rg.bandPts==null ? '—' : rg.bandPts+'pt', 'neutral'],
      ['Spot in band', rg.inBand==null ? '—' : (rg.inBand ? 'yes' : 'no'), rg.inBand===false ? 'ce' : 'neutral'],
      ['PCR (band)', p.pcr==null ? '—' : p.pcr.toFixed(2), 'neutral'],
      ['Updated', d.serverTime, 'neutral']
    ].map(function(x){
      return '<div class="stat"><div class="k">'+esc(x[0])+'</div><div class="v '+x[2]+'">'+esc(x[1])+'</div></div>';
    }).join('');
    if (w.atBandEdge) strip += '<div class="stat" style="border-color:#403000"><div class="k">⚠ wall</div>' +
      '<div class="v" style="font-size:0.65rem;color:#fbbf24">at band edge — true wall may be outside ATM±N</div></div>';
    document.getElementById('strip').innerHTML = strip;

    var tb = document.getElementById('ladder');
    if (!s.rows.length) { tb.innerHTML = '<tr><td colspan="9" class="empty">'+esc(d.emptyReason||'no data')+'</td></tr>'; }
    else {
      tb.innerHTML = s.rows.map(function(r){
        var ce = r.CE || {}, pe = r.PE || {};
        var ceW = (w.ce && w.ce.strike===r.strike) ? ' wall-ce' : '';
        var peW = (w.pe && w.pe.strike===r.strike) ? ' wall-pe' : '';
        return '<tr class="'+(r.isAtm?'atm':'')+'">'
          + '<td class="l'+ceW+'">'+nfmt(ce.oi)+'</td>'
          + dcell(ce.deltas && ce.deltas[LB[0]]) + dcell(ce.deltas && ce.deltas[LB[1]]) + dcell(ce.deltas && ce.deltas[LB[2]])
          + '<td class="c strike">'+r.strike+'</td>'
          + dcell(pe.deltas && pe.deltas[LB[2]]) + dcell(pe.deltas && pe.deltas[LB[1]]) + dcell(pe.deltas && pe.deltas[LB[0]])
          + '<td class="'+peW+'">'+nfmt(pe.oi)+'</td>'
          + '</tr>';
      }).join('');
    }

    var c = document.getElementById('cands');
    if (!d.candidates.length) c.innerHTML = '<div class="empty">nothing yet — patterns appear here as they occur</div>';
    else c.innerHTML = d.candidates.map(function(x){
      return '<div class="row"><span class="t">'+esc(x.time)+'</span>'
        + '<span class="tag '+esc(x.kind)+'">'+esc(x.kind)+'</span>'
        + '<span class="tag '+esc(x.side)+'">'+esc(x.side)+'</span>'
        + '<span class="t">'+esc(x.spot)+'</span>'
        + '<span class="n">'+esc(x.note)+'</span></div>';
    }).join('');
  }

  function poll(){
    fetch('/oi-monitor/data').then(function(r){ return r.json(); })
      .then(function(d){ if (d.ok) render(d); })
      .catch(function(){ /* transient — the next poll retries */ });
  }
  poll();
  setInterval(poll, 5000);
</script>
</body>
</html>`);
});

module.exports = router;

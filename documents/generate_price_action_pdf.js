const puppeteer = require("puppeteer");
const path = require("path");

// ── SVG Chart Helpers ───────────────────────────────────────────────────────

function candleSVG(x, open, high, low, close, w) {
  w = w || 6;
  const top = Math.min(open, close);
  const bot = Math.max(open, close);
  const color = close >= open ? '#4caf50' : '#e53935';
  const hx = x;
  return `<line x1="${hx}" y1="${low}" x2="${hx}" y2="${high}" stroke="${color}" stroke-width="0.8"/>
<rect x="${x - w/2}" y="${top}" width="${w}" height="${Math.max(bot - top, 0.5)}" fill="${color}" rx="0.5"/>`;
}

function arrowUp(x, y, label) {
  return `<polygon points="${x-5},${y} ${x},${y-10} ${x+5},${y}" fill="#4caf50"/>
<text x="${x}" y="${y-13}" text-anchor="middle" fill="#4caf50" font-size="8" font-weight="bold">${label || 'CE'}</text>`;
}
function arrowDown(x, y, label) {
  return `<polygon points="${x-5},${y} ${x},${y+10} ${x+5},${y}" fill="#e53935"/>
<text x="${x}" y="${y+22}" text-anchor="middle" fill="#e53935" font-size="8" font-weight="bold">${label || 'PE'}</text>`;
}
function hLine(y, x1, x2, color, label, dash) {
  return `<line x1="${x1}" y1="${y}" x2="${x2}" y2="${y}" stroke="${color}" stroke-width="1" ${dash ? 'stroke-dasharray="4,3"' : ''}/>
${label ? `<text x="${x2+4}" y="${y+3}" fill="${color}" font-size="8">${label}</text>` : ''}`;
}

// ── Chart: Bullish Engulfing at Support ─────────────────────────────────────
function engulfingChart() {
  // Downtrend → support zone → bullish engulfing → entry
  const candles = [
    // x, open, high, low, close  (Y axis: 20=top, 160=bottom)
    [30,  50, 45, 75, 70],   // red
    [50,  68, 62, 88, 85],   // red
    [70,  83, 78, 100, 96],  // red
    [90,  95, 88, 115, 112], // red - approaches support
    [110, 110, 105, 130, 128],// red - at support (prev candle)
    [130, 130, 95, 135, 98], // GREEN - bullish engulfing! body engulfs prev
    [150, 96, 82, 100, 85],  // green - continuation
    [170, 84, 70, 88, 73],   // green - continuation
  ];
  let svg = candles.map(c => candleSVG(c[0], c[1], c[2], c[3], c[4], 10)).join('\n');
  // Support zone
  svg += `<rect x="10" y="125" width="190" height="12" fill="#4caf50" opacity="0.08" rx="2"/>`;
  svg += hLine(131, 10, 200, '#4caf50', 'Support', true);
  // Entry arrow
  svg += arrowUp(130, 92, 'BUY CE');
  // SL line at engulfing candle low
  svg += hLine(135, 120, 180, '#e53935', 'SL', true);
  return svg;
}

// ── Chart: Bearish Engulfing at Resistance ──────────────────────────────────
function bearishEngulfingChart() {
  const candles = [
    [30,  130, 125, 110, 115], // green
    [50,  113, 105, 95, 100],  // green
    [70,  98, 90, 80, 84],     // green
    [90,  82, 72, 68, 70],     // green - approaches resistance
    [110, 72, 55, 75, 58],     // green - at resistance (prev)
    [130, 56, 50, 90, 85],     // RED - bearish engulfing!
    [150, 87, 82, 100, 96],    // red continuation
    [170, 98, 92, 112, 108],   // red continuation
  ];
  let svg = candles.map(c => candleSVG(c[0], c[1], c[2], c[3], c[4], 10)).join('\n');
  // Resistance zone
  svg += `<rect x="10" y="48" width="190" height="12" fill="#e53935" opacity="0.08" rx="2"/>`;
  svg += hLine(54, 10, 200, '#e53935', 'Resistance', true);
  // Entry arrow
  svg += arrowDown(130, 93, 'BUY PE');
  // SL at engulfing candle high
  svg += hLine(50, 120, 180, '#e53935', 'SL', true);
  return svg;
}

// ── Chart: Hammer (Pin Bar) at Support ──────────────────────────────────────
function hammerChart() {
  const candles = [
    [30,  55, 48, 72, 68],    // red
    [50,  66, 60, 85, 82],    // red
    [70,  80, 75, 98, 95],    // red
    [90,  94, 88, 110, 106],  // red
    [110, 105, 100, 135, 103],// HAMMER - long lower wick, small body at top
    [130, 102, 88, 106, 90],  // green continuation
    [150, 89, 76, 92, 78],    // green
  ];
  let svg = candles.map(c => candleSVG(c[0], c[1], c[2], c[3], c[4], 10)).join('\n');
  // Support zone
  svg += `<rect x="10" y="128" width="170" height="12" fill="#4caf50" opacity="0.08" rx="2"/>`;
  svg += hLine(134, 10, 180, '#4caf50', 'Support', true);
  // Wick annotation
  svg += `<text x="118" y="125" fill="#ff9800" font-size="7" font-style="italic">long wick = rejection</text>`;
  // Entry
  svg += arrowUp(110, 96, 'BUY CE');
  // SL at pin bar low
  svg += hLine(135, 100, 160, '#e53935', 'SL', true);
  return svg;
}

// ── Chart: Inside Bar Breakout ──────────────────────────────────────────────
function insideBarChart() {
  const candles = [
    [30,  65, 55, 95, 90],    // red (big mother candle)
    [50,  88, 75, 92, 78],    // green INSIDE BAR (within mother)
    [70,  76, 48, 80, 52],    // GREEN BREAKOUT above mother high
    [90,  50, 38, 55, 42],    // continuation
    [110, 40, 30, 46, 34],    // continuation
  ];
  // Draw mother candle larger
  let svg = candleSVG(30, 65, 55, 95, 90, 14);
  svg += candles.slice(1).map(c => candleSVG(c[0], c[1], c[2], c[3], c[4], 10)).join('\n');
  // Mother candle range lines
  svg += hLine(55, 20, 140, '#ff9800', 'Mother High', true);
  svg += hLine(95, 20, 140, '#ff9800', 'Mother Low', true);
  // Inside bar label
  svg += `<text x="50" y="68" fill="#2196f3" font-size="7" font-weight="bold">Inside Bar</text>`;
  // Breakout arrow
  svg += arrowUp(70, 44, 'BUY CE');
  // SL at mother low
  svg += hLine(95, 60, 130, '#e53935', 'SL', true);
  return svg;
}

// ── Chart: Break of Structure (BOS) ─────────────────────────────────────────
function bosChart() {
  const candles = [
    [25,  110, 105, 125, 120],
    [45,  118, 100, 122, 104],// swing high at 100
    [65,  106, 98, 118, 115],
    [85,  113, 95, 116, 98],  // swing high at 95
    [105, 100, 88, 106, 90],  // green
    [125, 88, 75, 92, 78],    // green
    [145, 80, 65, 84, 68],    // BOS! closes above swing high at 95 → wait, bearish BOS
  ];
  // Actually let's do a bullish BOS
  const candles2 = [
    [25,  120, 115, 140, 137],// red
    [45,  135, 110, 138, 113],// green - swing low at 110
    [65,  115, 108, 130, 128],// red
    [85,  126, 100, 130, 103],// green - lower swing
    [105, 105, 95, 115, 97],  // green
    [125, 95, 82, 100, 85],   // green - breaks above prev swing high (108)
    [145, 83, 72, 88, 75],    // continuation
  ];
  let svg = candles2.map(c => candleSVG(c[0], c[1], c[2], c[3], c[4], 10)).join('\n');
  // Swing high line
  svg += hLine(95, 10, 170, '#2196f3', '', true);
  svg += `<text x="8" y="92" fill="#2196f3" font-size="7">Swing High</text>`;
  // BOS annotation
  svg += `<text x="125" y="78" fill="#4caf50" font-size="8" font-weight="bold">BOS!</text>`;
  svg += arrowUp(125, 80, 'BUY CE');
  return svg;
}

// ── Chart: Swing Trailing SL ────────────────────────────────────────────────
function trailingSLChart() {
  const candles = [
    [25,  130, 125, 140, 138],
    [45,  136, 118, 140, 120],// entry here
    [65,  122, 108, 128, 110],// swing low 1 at 108
    [85,  108, 95, 114, 98],
    [105, 100, 85, 106, 88],  // swing low 2 at 85
    [125, 86, 75, 92, 78],
    [145, 80, 68, 84, 70],    // swing low 3 at 68
    [165, 72, 60, 78, 62],
    [185, 60, 55, 66, 58],
  ];
  let svg = candles.map(c => candleSVG(c[0], c[1], c[2], c[3], c[4], 8)).join('\n');
  // Entry marker
  svg += arrowUp(45, 115, 'Entry');
  // Initial SL
  svg += `<line x1="35" y1="140" x2="75" y2="140" stroke="#e53935" stroke-width="1.5"/>`;
  svg += `<text x="78" y="143" fill="#e53935" font-size="7">SL1 (initial)</text>`;
  // Swing low trail levels
  svg += `<line x1="55" y1="128" x2="115" y2="128" stroke="#ff9800" stroke-width="1.5" stroke-dasharray="3,2"/>`;
  svg += `<text x="118" y="131" fill="#ff9800" font-size="7">SL2 (swing low)</text>`;
  svg += `<line x1="95" y1="106" x2="155" y2="106" stroke="#ff9800" stroke-width="1.5" stroke-dasharray="3,2"/>`;
  svg += `<text x="158" y="109" fill="#ff9800" font-size="7">SL3 (tightened)</text>`;
  // Arrow showing SL moving up
  svg += `<path d="M50,140 L50,128 L60,128" fill="none" stroke="#ff9800" stroke-width="0.8" marker-end="url(#arrowhead)"/>`;
  svg += `<defs><marker id="arrowhead" markerWidth="6" markerHeight="4" refX="6" refY="2" orient="auto"><polygon points="0 0, 6 2, 0 4" fill="#ff9800"/></marker></defs>`;
  return svg;
}

// ── Chart: Support/Resistance from Swing Points ─────────────────────────────
function swingPointChart() {
  const candles = [
    [20, 90, 82, 100, 95],
    [35, 93, 78, 98, 80],   // swing high at 78
    [50, 82, 75, 95, 92],
    [65, 90, 70, 96, 72],   // swing high at 70
    [80, 74, 65, 88, 85],
    [95, 83, 72, 95, 90],
    [110, 88, 80, 105, 102],
    [125, 100, 95, 115, 112],
    [140, 110, 98, 118, 100],// swing high at 98
    [155, 102, 92, 110, 95],
    [170, 97, 88, 108, 105],
    [185, 103, 95, 112, 98],
  ];
  let svg = candles.map(c => candleSVG(c[0], c[1], c[2], c[3], c[4], 8)).join('\n');
  // Mark swing highs (resistance)
  svg += `<circle cx="35" cy="78" r="4" fill="none" stroke="#e53935" stroke-width="1.5"/>`;
  svg += `<circle cx="65" cy="70" r="4" fill="none" stroke="#e53935" stroke-width="1.5"/>`;
  svg += `<circle cx="140" cy="98" r="4" fill="none" stroke="#e53935" stroke-width="1.5"/>`;
  // Mark swing lows (support)
  svg += `<circle cx="20" cy="100" r="4" fill="none" stroke="#4caf50" stroke-width="1.5"/>`;
  svg += `<circle cx="50" cy="95" r="4" fill="none" stroke="#4caf50" stroke-width="1.5"/>`;
  svg += `<circle cx="125" cy="115" r="4" fill="none" stroke="#4caf50" stroke-width="1.5"/>`;
  // S/R zones
  svg += `<rect x="10" y="67" width="190" height="8" fill="#e53935" opacity="0.08"/>`;
  svg += `<text x="155" y="64" fill="#e53935" font-size="7">Resistance Zone</text>`;
  svg += `<rect x="10" y="110" width="190" height="8" fill="#4caf50" opacity="0.08"/>`;
  svg += `<text x="155" y="124" fill="#4caf50" font-size="7">Support Zone</text>`;
  return svg;
}


const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  @page { size: A4; margin: 0; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'Helvetica Neue', Arial, sans-serif; color: #1a1a2e; background: #fff; font-size: 11px; line-height: 1.5; }

  .cover { height: 100vh; display: flex; flex-direction: column; justify-content: center; align-items: center; background: linear-gradient(135deg, #0f2027 0%, #203a43 50%, #2c5364 100%); color: #fff; page-break-after: always; text-align: center; padding: 60px; }
  .cover h1 { font-size: 42px; font-weight: 800; letter-spacing: -1px; margin-bottom: 10px; }
  .cover .subtitle { font-size: 18px; color: #a8d8ea; margin-bottom: 30px; }
  .cover .version { font-size: 13px; color: #7aaabb; border: 1px solid #7aaabb; padding: 4px 16px; border-radius: 20px; display: inline-block; }
  .cover .badge { background: #26c6da; color: #0f2027; padding: 6px 18px; border-radius: 20px; font-weight: 700; font-size: 14px; margin-top: 20px; }

  .page { padding: 40px 50px; page-break-after: always; min-height: 100vh; position: relative; }
  .page:last-child { page-break-after: avoid; }
  .page-header { font-size: 9px; color: #999; text-align: right; margin-bottom: 20px; border-bottom: 1px solid #eee; padding-bottom: 5px; }

  h2 { font-size: 22px; color: #203a43; margin: 20px 0 12px; border-left: 4px solid #26c6da; padding-left: 12px; }
  h3 { font-size: 15px; color: #2c5364; margin: 14px 0 8px; }
  h4 { font-size: 13px; color: #203a43; margin: 10px 0 6px; }
  p { margin-bottom: 8px; color: #333; }
  ul { margin: 6px 0 10px 20px; }
  li { margin-bottom: 4px; }

  .indicator-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin: 12px 0; }
  .indicator-card { background: #f8f9ff; border: 1px solid #e0e0f0; border-radius: 8px; padding: 14px; }
  .indicator-card h4 { font-size: 13px; color: #203a43; margin-bottom: 6px; }
  .indicator-card .param { font-size: 10px; color: #666; background: #eef; padding: 2px 8px; border-radius: 10px; display: inline-block; margin: 2px; }

  .signal-box { border-radius: 10px; padding: 16px; margin: 12px 0; }
  .signal-long { background: linear-gradient(135deg, #e8f5e9, #f1f8e9); border: 1px solid #81c784; }
  .signal-short { background: linear-gradient(135deg, #fce4ec, #fff3e0); border: 1px solid #e57373; }
  .signal-box h3 { margin-top: 0; }
  .signal-box .condition { display: flex; align-items: center; margin: 4px 0; font-size: 11px; }
  .signal-box .condition .icon { width: 20px; height: 20px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; margin-right: 8px; font-size: 12px; flex-shrink: 0; }
  .long-icon { background: #4caf50; color: #fff; }
  .short-icon { background: #e53935; color: #fff; }

  .exit-table { width: 100%; border-collapse: collapse; margin: 10px 0; font-size: 10.5px; }
  .exit-table th { background: #203a43; color: #fff; padding: 8px 10px; text-align: left; font-weight: 600; }
  .exit-table td { padding: 8px 10px; border-bottom: 1px solid #eee; }
  .exit-table tr:nth-child(even) { background: #f8f9ff; }
  .exit-table .priority { background: #26c6da; color: #0f2027; border-radius: 10px; padding: 2px 8px; font-weight: 700; font-size: 10px; }

  .config-table { width: 100%; border-collapse: collapse; margin: 10px 0; font-size: 10px; }
  .config-table th { background: #2c5364; color: #fff; padding: 6px 10px; text-align: left; }
  .config-table td { padding: 6px 10px; border-bottom: 1px solid #eee; font-family: 'Courier New', monospace; }
  .config-table tr:nth-child(even) { background: #f5f5ff; }

  .risk-card { display: flex; gap: 12px; margin: 12px 0; }
  .risk-item { flex: 1; background: #fff; border: 1px solid #e0e0f0; border-radius: 8px; padding: 14px; text-align: center; }
  .risk-item .value { font-size: 24px; font-weight: 800; color: #203a43; }
  .risk-item .label { font-size: 10px; color: #888; }

  .chart-box { background: #fafbff; border: 1px solid #e8eaf0; border-radius: 10px; padding: 16px; margin: 14px 0; text-align: center; }
  .chart-title { font-size: 11px; font-weight: 700; color: #203a43; margin-bottom: 8px; text-align: left; }

  .trail-example { background: #f0f4ff; border-radius: 8px; padding: 14px; margin: 10px 0; font-size: 11px; }
  .trail-step { display: flex; align-items: center; margin: 4px 0; }
  .trail-step .dot { width: 10px; height: 10px; border-radius: 50%; margin-right: 10px; flex-shrink: 0; }

  .flow-box { background: #f0f7ff; border: 1px solid #b3d9f2; border-radius: 10px; padding: 16px; margin: 14px 0; font-size: 10.5px; }
  .flow-step { display: flex; align-items: center; margin: 6px 0; }
  .flow-num { width: 22px; height: 22px; border-radius: 50%; background: #26c6da; color: #fff; font-weight: 700; font-size: 10px; display: flex; align-items: center; justify-content: center; margin-right: 10px; flex-shrink: 0; }
  .flow-arrow { text-align: center; color: #999; font-size: 14px; margin: 2px 0; }

  svg text { font-family: 'Helvetica Neue', Arial, sans-serif; }
  .footer { position: absolute; bottom: 20px; left: 50px; right: 50px; font-size: 8px; color: #aaa; border-top: 1px solid #eee; padding-top: 5px; display: flex; justify-content: space-between; }
</style>
</head>
<body>

<!-- ═══════════════ COVER PAGE ═══════════════ -->
<div class="cover">
  <div class="badge">NIFTY OPTIONS</div>
  <h1 style="margin-top:20px;">Price Action Strategy</h1>
  <div class="subtitle">PRICE_ACTION_5M &mdash; Pure Price Action Trading on 5-Minute Candles</div>
  <div style="margin:30px 0;">
    <svg width="400" height="180" viewBox="0 0 400 180">
      <!-- S/R zones background -->
      <rect x="20" y="30" width="360" height="10" fill="#e53935" opacity="0.06" rx="2"/>
      <rect x="20" y="140" width="360" height="10" fill="#4caf50" opacity="0.06" rx="2"/>
      <line x1="20" y1="35" x2="380" y2="35" stroke="#e53935" stroke-width="0.5" stroke-dasharray="4,3"/>
      <line x1="20" y1="145" x2="380" y2="145" stroke="#4caf50" stroke-width="0.5" stroke-dasharray="4,3"/>
      <text x="345" y="28" fill="#e53935" font-size="7" opacity="0.6">Resistance</text>
      <text x="345" y="158" fill="#4caf50" font-size="7" opacity="0.6">Support</text>
      <!-- Price action candles -->
      ${(() => {
        const c = [
          [40,80,70,100,95],[60,93,82,110,105],[80,103,90,120,115],[100,113,100,130,125],
          [120,123,110,140,135],[140,133,120,145,140],[160,142,138,148,140],
          [180,138,130,145,135],[200,137,128,142,130],[220,132,120,138,125],
          [240,127,118,135,120],[260,122,110,128,115],[280,117,108,125,120],
          [300,122,115,135,128],[320,126,108,130,112],[340,110,95,118,98],[360,100,85,105,88]
        ];
        return c.map(v => candleSVG(v[0],v[1],v[2],v[3],v[4],8)).join('\n');
      })()}
      <!-- Pattern markers -->
      <polygon points="155,125 160,115 165,125" fill="#4caf50" opacity="0.8"/>
      <text x="160" y="112" text-anchor="middle" fill="#4caf50" font-size="7" font-weight="bold">Engulfing</text>
      <polygon points="335,100 340,110 345,100" fill="#e53935" opacity="0.8"/>
      <text x="340" y="122" text-anchor="middle" fill="#e53935" font-size="7" font-weight="bold">Pin Bar</text>
    </svg>
  </div>
  <div class="version">Version 1.0 &bull; 5-Min Timeframe &bull; S/R + Patterns + RSI</div>
  <p style="margin-top:30px; font-size:11px; color:#7aaabb;">Engulfing &bull; Pin Bar &bull; Inside Bar Breakout &bull; Break of Structure &bull; Swing Trail SL</p>
</div>

<!-- ═══════════════ PAGE 2: OVERVIEW ═══════════════ -->
<div class="page">
  <div class="page-header">Price Action Strategy Guide &mdash; Page 2</div>
  <h2>1. Strategy Overview</h2>
  <p>The <strong>PRICE_ACTION_5M</strong> strategy is a <strong>5-minute</strong> timeframe system designed for <strong>NIFTY index options</strong> (CE/PE). Unlike indicator-heavy approaches, it reads <strong>what price itself is doing</strong> &mdash; identifying candlestick patterns at key Support/Resistance levels, confirmed by RSI momentum.</p>

  <div class="risk-card">
    <div class="risk-item"><div class="value">5 min</div><div class="label">Candle Timeframe</div></div>
    <div class="risk-item"><div class="value">S/R</div><div class="label">Support &amp; Resistance</div></div>
    <div class="risk-item"><div class="value">Patterns</div><div class="label">Engulf / Pin / IB / BOS</div></div>
    <div class="risk-item"><div class="value">Swing</div><div class="label">Trailing SL Method</div></div>
  </div>

  <h3>Core Principle</h3>
  <p>Price action trading focuses on <strong>price structure</strong> rather than lagging indicators. The strategy identifies 5 pattern types, but only takes trades when the pattern occurs at a <strong>meaningful S/R level</strong> (swing high/low). RSI acts as a lightweight confirmation filter &mdash; not the primary signal.</p>

  <h3>Why Price Action on 5-Min?</h3>
  <ul>
    <li><strong>More opportunities</strong> than 15-min (3x candles per day)</li>
    <li><strong>Cleaner patterns</strong> than 3-min (less noise, fewer false signals)</li>
    <li><strong>Reasonable SL</strong> from signal candle wick (typically 10-20 pts)</li>
    <li><strong>No lag</strong> &mdash; reacts to what price is doing NOW, not what indicators say it was doing</li>
  </ul>

  <h2>2. Support &amp; Resistance Detection</h2>
  <p>S/R levels are derived dynamically from <strong>swing highs and swing lows</strong> in the last 30 candles. A swing high is a candle whose high is greater than both neighbors. A swing low is a candle whose low is less than both neighbors.</p>

  <div class="chart-box">
    <div class="chart-title">Swing Points &rarr; Support &amp; Resistance Zones</div>
    <svg width="210" height="140" viewBox="0 0 210 140">${swingPointChart()}</svg>
    <p style="font-size:9px; color:#888; margin-top:6px;">Red circles = swing highs (resistance). Green circles = swing lows (support). Shaded = S/R zone (&#177;15 pts).</p>
  </div>

  <table class="config-table">
    <tr><th>Parameter</th><th>Setting Key</th><th>Default</th><th>Description</th></tr>
    <tr><td>Lookback</td><td>PA_SR_LOOKBACK</td><td>30</td><td>Candles to scan for swing points</td></tr>
    <tr><td>Zone Width</td><td>PA_SR_ZONE_PTS</td><td>15 pts</td><td>Price must be within this distance of S/R level</td></tr>
  </table>

  <div class="footer"><span>Price Action Strategy Guide</span><span>Page 2</span></div>
</div>

<!-- ═══════════════ PAGE 3: ENTRY PATTERNS ═══════════════ -->
<div class="page">
  <div class="page-header">Price Action Strategy Guide &mdash; Page 3</div>
  <h2>3. Entry Patterns</h2>
  <p>Five patterns are detected, each requiring <strong>S/R confluence</strong> and <strong>RSI confirmation</strong>. Patterns are checked in priority order.</p>

  <h3>Pattern 1: Bullish Engulfing at Support</h3>
  <div class="signal-box signal-long">
    <h3 style="color:#2e7d32;">BUY CE &mdash; Bullish Engulfing</h3>
    <div class="condition"><span class="icon long-icon">1</span>Previous candle is RED (bearish)</div>
    <div class="condition"><span class="icon long-icon">2</span>Current candle is GREEN and its body fully engulfs the previous candle's body</div>
    <div class="condition"><span class="icon long-icon">3</span>Current candle's <strong>low is within 15 pts of a swing low</strong> (support zone)</div>
    <div class="condition"><span class="icon long-icon">4</span>RSI &gt; 45 (not deeply oversold &mdash; momentum supports move up)</div>
    <div class="condition"><span class="icon long-icon">5</span>Candle body &ge; 5 pts (filters out dojis)</div>
    <p style="margin-top:8px;"><strong>SL:</strong> Signal candle low &nbsp;|&nbsp; <strong>Strength:</strong> STRONG (immediate entry)</p>
  </div>

  <div class="chart-box">
    <div class="chart-title">Bullish Engulfing at Support &mdash; BUY CE</div>
    <svg width="210" height="160" viewBox="0 0 210 160">${engulfingChart()}</svg>
  </div>

  <h3>Pattern 2: Bearish Engulfing at Resistance</h3>
  <div class="signal-box signal-short">
    <h3 style="color:#c62828;">BUY PE &mdash; Bearish Engulfing</h3>
    <div class="condition"><span class="icon short-icon">1</span>Previous candle is GREEN (bullish)</div>
    <div class="condition"><span class="icon short-icon">2</span>Current candle is RED and its body fully engulfs the previous candle's body</div>
    <div class="condition"><span class="icon short-icon">3</span>Current candle's <strong>high is within 15 pts of a swing high</strong> (resistance zone)</div>
    <div class="condition"><span class="icon short-icon">4</span>RSI &lt; 55 (not overbought &mdash; momentum supports move down)</div>
    <div class="condition"><span class="icon short-icon">5</span>Candle body &ge; 5 pts</div>
    <p style="margin-top:8px;"><strong>SL:</strong> Signal candle high &nbsp;|&nbsp; <strong>Strength:</strong> STRONG</p>
  </div>

  <div class="chart-box">
    <div class="chart-title">Bearish Engulfing at Resistance &mdash; BUY PE</div>
    <svg width="210" height="160" viewBox="0 0 210 160">${bearishEngulfingChart()}</svg>
  </div>

  <div class="footer"><span>Price Action Strategy Guide</span><span>Page 3</span></div>
</div>

<!-- ═══════════════ PAGE 4: MORE PATTERNS ═══════════════ -->
<div class="page">
  <div class="page-header">Price Action Strategy Guide &mdash; Page 4</div>

  <h3>Pattern 3: Hammer (Pin Bar) at Support</h3>
  <div class="signal-box signal-long">
    <h3 style="color:#2e7d32;">BUY CE &mdash; Hammer</h3>
    <div class="condition"><span class="icon long-icon">1</span>Lower wick &ge; 2&times; the body size (long rejection wick)</div>
    <div class="condition"><span class="icon long-icon">2</span>Upper wick &le; 0.5&times; the body size (small upper shadow)</div>
    <div class="condition"><span class="icon long-icon">3</span>Candle low within <strong>support zone</strong> (15 pts of swing low)</div>
    <div class="condition"><span class="icon long-icon">4</span>RSI &gt; 45 &nbsp;|&nbsp; Body &ge; 2 pts minimum</div>
    <p style="margin-top:8px;"><strong>SL:</strong> Pin bar low &nbsp;|&nbsp; <strong>Strength:</strong> MARGINAL (wait for close confirmation)</p>
  </div>

  <div class="chart-box">
    <div class="chart-title">Hammer at Support &mdash; Long Wick Rejection</div>
    <svg width="190" height="150" viewBox="0 0 190 150">${hammerChart()}</svg>
  </div>

  <h3>Pattern 4: Shooting Star (Bearish Pin Bar) at Resistance</h3>
  <div class="signal-box signal-short">
    <h3 style="color:#c62828;">BUY PE &mdash; Shooting Star</h3>
    <div class="condition"><span class="icon short-icon">1</span>Upper wick &ge; 2&times; the body size (long rejection wick upward)</div>
    <div class="condition"><span class="icon short-icon">2</span>Lower wick &le; 0.5&times; the body size</div>
    <div class="condition"><span class="icon short-icon">3</span>Candle high within <strong>resistance zone</strong></div>
    <div class="condition"><span class="icon short-icon">4</span>RSI &lt; 55 &nbsp;|&nbsp; Body &ge; 2 pts minimum</div>
    <p style="margin-top:8px;"><strong>SL:</strong> Pin bar high &nbsp;|&nbsp; <strong>Strength:</strong> MARGINAL</p>
  </div>

  <h3>Pattern 5: Inside Bar Breakout</h3>
  <p>An <strong>inside bar</strong> is a candle whose entire range fits within the previous candle's range (the "mother candle"). It signals consolidation. Entry triggers when <strong>the next candle breaks out</strong> of the mother candle's range.</p>

  <div class="indicator-grid">
    <div class="signal-box signal-long" style="margin:0;">
      <h3 style="color:#2e7d32; font-size:12px;">CE Breakout</h3>
      <div class="condition"><span class="icon long-icon">1</span>Breakout candle closes ABOVE mother high</div>
      <div class="condition"><span class="icon long-icon">2</span>RSI &gt; 45</div>
      <p style="font-size:10px;"><strong>SL:</strong> Mother candle low</p>
    </div>
    <div class="signal-box signal-short" style="margin:0;">
      <h3 style="color:#c62828; font-size:12px;">PE Breakout</h3>
      <div class="condition"><span class="icon short-icon">1</span>Breakout candle closes BELOW mother low</div>
      <div class="condition"><span class="icon short-icon">2</span>RSI &lt; 55</div>
      <p style="font-size:10px;"><strong>SL:</strong> Mother candle high</p>
    </div>
  </div>

  <div class="chart-box">
    <div class="chart-title">Inside Bar Breakout &mdash; Consolidation &rarr; Expansion</div>
    <svg width="160" height="140" viewBox="0 0 160 140">${insideBarChart()}</svg>
    <p style="font-size:9px; color:#888; margin-top:6px;">Orange lines = mother candle range. Inside bar fits within. Breakout candle triggers entry.</p>
  </div>

  <p><strong>Note:</strong> Inside Bar does NOT require S/R confluence (breakouts work anywhere). If no breakout occurs within 3 candles, the pending signal is cancelled.</p>

  <div class="footer"><span>Price Action Strategy Guide</span><span>Page 4</span></div>
</div>

<!-- ═══════════════ PAGE 5: BOS + EXIT LOGIC ═══════════════ -->
<div class="page">
  <div class="page-header">Price Action Strategy Guide &mdash; Page 5</div>

  <h3>Pattern 6: Break of Structure (BOS)</h3>
  <p>A BOS occurs when price <strong>closes beyond the most recent swing high or swing low</strong>, indicating a shift in market structure. This is the strongest signal type.</p>

  <div class="indicator-grid">
    <div class="signal-box signal-long" style="margin:0;">
      <h3 style="color:#2e7d32; font-size:12px;">Bullish BOS</h3>
      <div class="condition"><span class="icon long-icon">1</span>Candle closes ABOVE last swing high</div>
      <div class="condition"><span class="icon long-icon">2</span>Candle opened AT or BELOW that swing high</div>
      <div class="condition"><span class="icon long-icon">3</span>RSI &gt; 45 + body &ge; 5 pts</div>
      <p style="font-size:10px;"><strong>SL:</strong> Recent swing low</p>
    </div>
    <div class="signal-box signal-short" style="margin:0;">
      <h3 style="color:#c62828; font-size:12px;">Bearish BOS</h3>
      <div class="condition"><span class="icon short-icon">1</span>Candle closes BELOW last swing low</div>
      <div class="condition"><span class="icon short-icon">2</span>Candle opened AT or ABOVE that swing low</div>
      <div class="condition"><span class="icon short-icon">3</span>RSI &lt; 55 + body &ge; 5 pts</div>
      <p style="font-size:10px;"><strong>SL:</strong> Recent swing high</p>
    </div>
  </div>

  <div class="chart-box">
    <div class="chart-title">Bullish Break of Structure (BOS)</div>
    <svg width="180" height="140" viewBox="0 0 180 140">${bosChart()}</svg>
  </div>

  <h2>4. Stop Loss Rules</h2>
  <p>Every entry has an <strong>initial SL</strong> derived from the signal candle, then clamped within safe limits:</p>

  <table class="exit-table">
    <tr><th>Pattern</th><th>CE Stop Loss</th><th>PE Stop Loss</th></tr>
    <tr><td>Bullish Engulfing</td><td>Signal candle LOW</td><td>&mdash;</td></tr>
    <tr><td>Bearish Engulfing</td><td>&mdash;</td><td>Signal candle HIGH</td></tr>
    <tr><td>Hammer</td><td>Pin bar LOW (wick tip)</td><td>&mdash;</td></tr>
    <tr><td>Shooting Star</td><td>&mdash;</td><td>Pin bar HIGH (wick tip)</td></tr>
    <tr><td>Inside Bar</td><td>Mother candle LOW</td><td>Mother candle HIGH</td></tr>
    <tr><td>BOS (Bullish)</td><td>min(current low, prev low)</td><td>&mdash;</td></tr>
    <tr><td>BOS (Bearish)</td><td>&mdash;</td><td>max(current high, prev high)</td></tr>
  </table>

  <div class="risk-card">
    <div class="risk-item"><div class="value">8 pts</div><div class="label">Min SL Floor (PA_MIN_SL_PTS)</div></div>
    <div class="risk-item"><div class="value">25 pts</div><div class="label">Max SL Cap (PA_MAX_SL_PTS)</div></div>
  </div>
  <p><strong>Clamping rule:</strong> <code>SL distance = max(min(raw_distance, 25), 8)</code>. Too-tight SL on tiny candles is floored to 8 pts. Too-wide SL on volatile candles is capped at 25 pts.</p>

  <div class="footer"><span>Price Action Strategy Guide</span><span>Page 5</span></div>
</div>

<!-- ═══════════════ PAGE 6: TRAILING + EXIT ═══════════════ -->
<div class="page">
  <div class="page-header">Price Action Strategy Guide &mdash; Page 6</div>

  <h2>5. Trailing Stop Loss (Swing-Based)</h2>
  <p>After entry, the SL is <strong>trailed using swing structure</strong> &mdash; moving the SL to the most recent swing low (for CE) or swing high (for PE). The trailing SL only tightens, never widens.</p>

  <div class="chart-box">
    <div class="chart-title">Swing-Based Trailing SL &mdash; CE Example (SL moves up with each new swing low)</div>
    <svg width="200" height="160" viewBox="0 0 200 160">${trailingSLChart()}</svg>
    <p style="font-size:9px; color:#888; margin-top:6px;">SL1 = initial (signal candle). SL2 = first swing low above SL1. SL3 = next swing low (tighter). SL only moves UP for CE, never down.</p>
  </div>

  <div class="trail-example">
    <h4>Trailing Rules</h4>
    <div class="trail-step"><div class="dot" style="background:#4caf50;"></div><strong>CE (Long):</strong>&nbsp; Trail to latest swing low &mdash; must be ABOVE current SL AND below current price</div>
    <div class="trail-step"><div class="dot" style="background:#e53935;"></div><strong>PE (Short):</strong>&nbsp; Trail to latest swing high &mdash; must be BELOW current SL AND above current price</div>
    <div class="trail-step"><div class="dot" style="background:#ff9800;"></div><strong>Key:</strong>&nbsp; Only tightens. If new swing point would widen SL, it's ignored.</div>
  </div>

  <h2>6. Exit Logic (Priority Order)</h2>
  <table class="exit-table">
    <tr><th><span class="priority">P</span></th><th>Exit Condition</th><th>Description</th><th>Applies To</th></tr>
    <tr><td><span class="priority">1</span></td><td><strong>SL Hit</strong></td><td>Price touches stop loss (initial or trailed)</td><td>Every tick</td></tr>
    <tr><td><span class="priority">2</span></td><td><strong>Trailing Profit %</strong></td><td>If peak PnL &ge; &pound;350, exit when profit drops below X% of peak. Tiered: 55% at &pound;500, 60% at &pound;1000, 70% at &pound;3000, 80% at &pound;5000, 90% at &pound;10000</td><td>Every tick</td></tr>
    <tr><td><span class="priority">3</span></td><td><strong>Swing Trail SL Update</strong></td><td>Tighten SL to latest swing low/high on each candle close</td><td>Candle close</td></tr>
    <tr><td><span class="priority">4</span></td><td><strong>EOD Square-Off</strong></td><td>Force exit at 3:20 PM IST (no overnight positions)</td><td>Time check</td></tr>
  </table>

  <h2>7. RSI as Confluence Filter</h2>
  <p>RSI is used as a <strong>lightweight confirmation</strong>, NOT the primary signal. It ensures momentum doesn't contradict the pattern.</p>

  <div class="indicator-grid">
    <div class="indicator-card">
      <h4>CE Entry (Bullish)</h4>
      <p>RSI must be &gt; <strong>45</strong>. This means momentum isn't deeply bearish. It's permissive &mdash; RSI 46 is fine for a CE entry because the pattern itself is the signal.</p>
      <span class="param">Default: PA_RSI_CE_MIN = 45</span>
    </div>
    <div class="indicator-card">
      <h4>PE Entry (Bearish)</h4>
      <p>RSI must be &lt; <strong>55</strong>. Momentum isn't deeply bullish. Same principle &mdash; the pattern leads, RSI confirms.</p>
      <span class="param">Default: PA_RSI_PE_MAX = 55</span>
    </div>
  </div>

  <div class="footer"><span>Price Action Strategy Guide</span><span>Page 6</span></div>
</div>

<!-- ═══════════════ PAGE 7: FLOW + CONFIG ═══════════════ -->
<div class="page">
  <div class="page-header">Price Action Strategy Guide &mdash; Page 7</div>

  <h2>8. Signal Flow (Decision Tree)</h2>
  <div class="flow-box">
    <div class="flow-step"><div class="flow-num">1</div>New 5-min candle closes</div>
    <div class="flow-arrow">&darr;</div>
    <div class="flow-step"><div class="flow-num">2</div>Check trading window (9:20 AM &ndash; 2:30 PM IST)</div>
    <div class="flow-arrow">&darr;</div>
    <div class="flow-step"><div class="flow-num">3</div>Check daily limits (max trades, max loss, SL pause)</div>
    <div class="flow-arrow">&darr;</div>
    <div class="flow-step"><div class="flow-num">4</div>Check VIX filter (if enabled)</div>
    <div class="flow-arrow">&darr;</div>
    <div class="flow-step"><div class="flow-num">5</div>Calculate RSI(14) + find swing highs/lows (last 30 candles)</div>
    <div class="flow-arrow">&darr;</div>
    <div class="flow-step"><div class="flow-num">6</div>Check pending <strong>Inside Bar breakout</strong> (if queued from prior candle)</div>
    <div class="flow-arrow">&darr;</div>
    <div class="flow-step"><div class="flow-num">7</div>Detect new <strong>Inside Bar</strong> &rarr; queue for next candle</div>
    <div class="flow-arrow">&darr;</div>
    <div class="flow-step"><div class="flow-num">8</div>Check <strong>Bullish Engulfing</strong> at support &rarr; check <strong>Bearish Engulfing</strong> at resistance</div>
    <div class="flow-arrow">&darr;</div>
    <div class="flow-step"><div class="flow-num">9</div>Check <strong>Hammer</strong> at support &rarr; check <strong>Shooting Star</strong> at resistance</div>
    <div class="flow-arrow">&darr;</div>
    <div class="flow-step"><div class="flow-num">10</div>Check <strong>Break of Structure</strong> (bullish/bearish)</div>
    <div class="flow-arrow">&darr;</div>
    <div class="flow-step"><div class="flow-num">11</div>If signal found &rarr; calculate SL (clamp 8&ndash;25 pts) &rarr; queue entry for NEXT candle open</div>
  </div>

  <h2>9. Full Configuration Reference</h2>
  <table class="config-table">
    <tr><th>Setting Key</th><th>Default</th><th>Description</th></tr>
    <tr><td>PA_MODE_ENABLED</td><td>true</td><td>Show/hide Price Action menus</td></tr>
    <tr><td>PA_RESOLUTION</td><td>5</td><td>Candle timeframe (minutes)</td></tr>
    <tr><td>PA_ENTRY_START</td><td>09:20</td><td>Earliest entry time (IST)</td></tr>
    <tr><td>PA_ENTRY_END</td><td>14:30</td><td>Latest entry time (IST)</td></tr>
    <tr><td>PA_RSI_PERIOD</td><td>14</td><td>RSI calculation period</td></tr>
    <tr><td>PA_RSI_CE_MIN</td><td>45</td><td>Min RSI for CE entries</td></tr>
    <tr><td>PA_RSI_PE_MAX</td><td>55</td><td>Max RSI for PE entries</td></tr>
    <tr><td>PA_MIN_BODY</td><td>5</td><td>Min candle body (pts) for engulfing/BOS</td></tr>
    <tr><td>PA_PIN_WICK_RATIO</td><td>2</td><td>Wick-to-body ratio for pin bars</td></tr>
    <tr><td>PA_SR_LOOKBACK</td><td>30</td><td>Candles to scan for swing points</td></tr>
    <tr><td>PA_SR_ZONE_PTS</td><td>15</td><td>S/R zone tolerance (pts)</td></tr>
    <tr><td>PA_MAX_SL_PTS</td><td>25</td><td>Max SL distance cap</td></tr>
    <tr><td>PA_MIN_SL_PTS</td><td>8</td><td>Min SL distance floor</td></tr>
    <tr><td>PA_MAX_DAILY_TRADES</td><td>30</td><td>Max entries per day</td></tr>
    <tr><td>PA_MAX_DAILY_LOSS</td><td>2000</td><td>Daily loss kill-switch (&pound;)</td></tr>
    <tr><td>PA_SL_PAUSE_CANDLES</td><td>2</td><td>Candles to pause after SL hit</td></tr>
    <tr><td>PA_TRAIL_START</td><td>350</td><td>Activate trailing after this profit (&pound;)</td></tr>
    <tr><td>PA_TRAIL_PCT</td><td>65</td><td>Base trail % of peak profit</td></tr>
    <tr><td>PA_TRAIL_TIERS</td><td>500:55,1000:60,...</td><td>Tiered trail percentages</td></tr>
    <tr><td>PA_VIX_ENABLED</td><td>false</td><td>VIX filter for PA entries</td></tr>
  </table>

  <div class="footer"><span>Price Action Strategy Guide</span><span>Page 7</span></div>
</div>

<!-- ═══════════════ PAGE 8: COMPARISON + TIPS ═══════════════ -->
<div class="page">
  <div class="page-header">Price Action Strategy Guide &mdash; Page 8</div>

  <h2>10. Price Action vs Other Strategies</h2>
  <table class="exit-table">
    <tr><th>Aspect</th><th>Strategy 1 (SAR+EMA+RSI)</th><th>Scalp (BB+RSI+PSAR)</th><th>Price Action</th></tr>
    <tr><td>Timeframe</td><td>15-min</td><td>5-min</td><td>5-min</td></tr>
    <tr><td>Entry Signal</td><td>EMA9 touch + SAR + RSI</td><td>BB breakout + RSI</td><td>Candle patterns at S/R</td></tr>
    <tr><td>Primary SL</td><td>SAR value</td><td>Previous candle</td><td>Signal candle wick</td></tr>
    <tr><td>Trailing SL</td><td>SAR dots (tiered)</td><td>PSAR (tighten only)</td><td>Swing lows/highs</td></tr>
    <tr><td>Lag</td><td>Medium (EMA + SAR)</td><td>Low (BB + RSI)</td><td><strong>None</strong> (reads price directly)</td></tr>
    <tr><td>Works in Range</td><td>No (ADX filter)</td><td>No (BB squeeze filter)</td><td><strong>Yes</strong> (inside bar breakouts)</td></tr>
    <tr><td>Best Condition</td><td>Clean trends</td><td>Volatile breakouts</td><td><strong>All conditions</strong></td></tr>
  </table>

  <h2>11. Practical Tips</h2>
  <div class="indicator-grid">
    <div class="indicator-card">
      <h4>Start with Backtest</h4>
      <p>Run <strong>/pa-backtest</strong> on the last 3-6 months first. Check win rate, drawdown, and which patterns perform best. Tune S/R zone width based on results.</p>
    </div>
    <div class="indicator-card">
      <h4>Paper Trade First</h4>
      <p>Use <strong>/pa-paper</strong> for at least 2 weeks of live simulation. Watch how patterns fire in real-time. Note which setups you'd trust and which feel forced.</p>
    </div>
    <div class="indicator-card">
      <h4>S/R Zone Tuning</h4>
      <p>If too few signals: increase <strong>PA_SR_ZONE_PTS</strong> (20-25). If too many false signals: decrease to 10. The zone width is the most impactful parameter.</p>
    </div>
    <div class="indicator-card">
      <h4>Pattern Quality</h4>
      <p><strong>Engulfing</strong> at S/R = highest conviction. <strong>BOS</strong> = strongest trend signal. <strong>Pin bars</strong> = marginal (need strong wick). <strong>Inside bar</strong> = works best in volatility compression.</p>
    </div>
  </div>

  <h2>12. Risk Management Summary</h2>
  <div class="risk-card">
    <div class="risk-item"><div class="value">8-25</div><div class="label">SL Range (pts)</div></div>
    <div class="risk-item"><div class="value">30</div><div class="label">Max Trades/Day</div></div>
    <div class="risk-item"><div class="value">&pound;2000</div><div class="label">Daily Loss Limit</div></div>
    <div class="risk-item"><div class="value">2+</div><div class="label">Pause After SL (candles)</div></div>
  </div>

  <p style="margin-top:20px; padding:14px; background:#f0f7ff; border-radius:8px; border:1px solid #b3d9f2;">
    <strong>Key insight:</strong> Price action trading is about reading <em>what the market is telling you</em> through its candle structure, not about calculating indicator values. The best price action setups have a clear story: "price hit support, formed a rejection candle, and buyers stepped in." If you can't explain the story in one sentence, the setup might not be clean enough.
  </p>

  <div class="footer"><span>Price Action Strategy Guide</span><span>Page 8</span></div>
</div>

</body>
</html>`;

(async () => {
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: "networkidle0" });
  await page.pdf({
    path: path.join(__dirname, "Price_Action_Strategy_Guide.pdf"),
    format: "A4",
    printBackground: true,
    margin: { top: 0, right: 0, bottom: 0, left: 0 }
  });
  await browser.close();
  console.log("PDF generated: documents/Price_Action_Strategy_Guide.pdf");
})();

const puppeteer = require("puppeteer");
const path = require("path");

const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  @page { size: A4; margin: 0; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'Helvetica Neue', Arial, sans-serif; color: #1a1a2e; background: #fff; font-size: 11px; line-height: 1.5; }

  .cover { height: 100vh; display: flex; flex-direction: column; justify-content: center; align-items: center; background: linear-gradient(135deg, #0f0c29 0%, #302b63 50%, #24243e 100%); color: #fff; page-break-after: always; text-align: center; padding: 60px; }
  .cover h1 { font-size: 42px; font-weight: 800; letter-spacing: -1px; margin-bottom: 10px; }
  .cover .subtitle { font-size: 18px; color: #a8a8d8; margin-bottom: 30px; }
  .cover .version { font-size: 13px; color: #7a7aaa; border: 1px solid #7a7aaa; padding: 4px 16px; border-radius: 20px; display: inline-block; }
  .cover .badge { background: #00d2ff; color: #0f0c29; padding: 6px 18px; border-radius: 20px; font-weight: 700; font-size: 14px; margin-top: 20px; }

  .page { padding: 40px 50px; page-break-after: always; min-height: 100vh; position: relative; }
  .page:last-child { page-break-after: avoid; }
  .page-header { font-size: 9px; color: #999; text-align: right; margin-bottom: 20px; border-bottom: 1px solid #eee; padding-bottom: 5px; }

  h2 { font-size: 22px; color: #302b63; margin: 20px 0 12px; border-left: 4px solid #00d2ff; padding-left: 12px; }
  h3 { font-size: 15px; color: #24243e; margin: 14px 0 8px; }
  p { margin-bottom: 8px; color: #333; }

  .indicator-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin: 12px 0; }
  .indicator-card { background: #f8f9ff; border: 1px solid #e0e0f0; border-radius: 8px; padding: 14px; }
  .indicator-card h4 { font-size: 13px; color: #302b63; margin-bottom: 6px; }
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
  .exit-table th { background: #302b63; color: #fff; padding: 8px 10px; text-align: left; font-weight: 600; }
  .exit-table td { padding: 8px 10px; border-bottom: 1px solid #eee; }
  .exit-table tr:nth-child(even) { background: #f8f9ff; }
  .exit-table .priority { background: #00d2ff; color: #0f0c29; border-radius: 10px; padding: 2px 8px; font-weight: 700; font-size: 10px; }

  .flow-diagram { background: #f8f9ff; border-radius: 10px; padding: 20px; margin: 12px 0; text-align: center; }

  .config-table { width: 100%; border-collapse: collapse; margin: 10px 0; font-size: 10px; }
  .config-table th { background: #24243e; color: #fff; padding: 6px 10px; text-align: left; }
  .config-table td { padding: 6px 10px; border-bottom: 1px solid #eee; font-family: 'Courier New', monospace; }
  .config-table tr:nth-child(even) { background: #f5f5ff; }

  .risk-card { display: flex; gap: 12px; margin: 12px 0; }
  .risk-item { flex: 1; background: #fff; border: 1px solid #e0e0f0; border-radius: 8px; padding: 14px; text-align: center; }
  .risk-item .value { font-size: 24px; font-weight: 800; color: #302b63; }
  .risk-item .label { font-size: 10px; color: #888; }

  .vix-zones { display: flex; gap: 0; margin: 12px 0; border-radius: 8px; overflow: hidden; }
  .vix-zone { flex: 1; padding: 12px; text-align: center; color: #fff; font-size: 11px; }
  .vix-green { background: #43a047; }
  .vix-yellow { background: #fb8c00; }
  .vix-red { background: #e53935; }

  .trail-example { background: #f0f4ff; border-radius: 8px; padding: 14px; margin: 10px 0; font-size: 11px; }
  .trail-step { display: flex; align-items: center; margin: 4px 0; }
  .trail-step .dot { width: 10px; height: 10px; border-radius: 50%; margin-right: 10px; flex-shrink: 0; }
  .trail-step .line { flex: 1; height: 2px; background: #ddd; margin: 0 8px; }

  svg text { font-family: 'Helvetica Neue', Arial, sans-serif; }

  .footer { position: absolute; bottom: 20px; left: 50px; right: 50px; font-size: 8px; color: #aaa; border-top: 1px solid #eee; padding-top: 5px; display: flex; justify-content: space-between; }
</style>
</head>
<body>

<!-- COVER PAGE -->
<div class="cover">
  <div class="badge">NIFTY OPTIONS</div>
  <h1 style="margin-top:20px;">Scalping Strategy</h1>
  <div class="subtitle">SCALP_BB_RSI_V4 &mdash; 3-Minute Bollinger Band + RSI Scalping</div>
  <div style="margin:30px 0;">
    <svg width="400" height="180" viewBox="0 0 400 180">
      <!-- Mini candlestick chart decoration -->
      <defs>
        <linearGradient id="bbFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#00d2ff" stop-opacity="0.15"/>
          <stop offset="100%" stop-color="#00d2ff" stop-opacity="0.02"/>
        </linearGradient>
      </defs>
      <!-- BB bands area -->
      <path d="M20,40 Q60,25 100,35 T180,30 T260,38 T340,28 L380,32 L380,148 Q340,155 300,145 T220,150 T140,148 T60,155 L20,150 Z" fill="url(#bbFill)" stroke="none"/>
      <path d="M20,40 Q60,25 100,35 T180,30 T260,38 T340,28 L380,32" fill="none" stroke="#00d2ff" stroke-width="1.5" stroke-dasharray="4,3"/>
      <path d="M20,150 Q60,155 100,145 T180,150 T260,148 T340,155 L380,148" fill="none" stroke="#00d2ff" stroke-width="1.5" stroke-dasharray="4,3"/>
      <!-- SMA middle -->
      <path d="M20,95 Q60,88 100,92 T180,88 T260,93 T340,90 L380,88" fill="none" stroke="#a8a8d8" stroke-width="1" stroke-dasharray="2,2"/>
      <!-- Candles -->
      ${generateCandles()}
      <!-- Entry arrows -->
      <polygon points="105,62 110,52 115,62" fill="#4caf50" opacity="0.9"/>
      <text x="110" y="48" text-anchor="middle" fill="#4caf50" font-size="8" font-weight="bold">CE</text>
      <polygon points="265,128 270,138 275,128" fill="#e53935" opacity="0.9"/>
      <text x="270" y="152" text-anchor="middle" fill="#e53935" font-size="8" font-weight="bold">PE</text>
    </svg>
  </div>
  <div class="version">Version 4.0 &bull; 3-Min Timeframe &bull; BB + RSI + PSAR</div>
  <p style="margin-top:30px; font-size:11px; color:#7a7aaa;">Automated Entry &bull; PSAR Trailing SL &bull; Profit Locking &bull; VIX Filter</p>
</div>

<!-- PAGE 2: STRATEGY OVERVIEW -->
<div class="page">
  <div class="page-header">SCALP_BB_RSI_V4 Strategy Guide &mdash; Page 2</div>
  <h2>1. Strategy Overview</h2>
  <p>The <strong>SCALP_BB_RSI_V4</strong> strategy is a <strong>3-minute</strong> timeframe scalping system designed for <strong>NIFTY index options</strong> (CE/PE). It identifies short-term momentum breakouts using Bollinger Bands and RSI, with dynamic stop-loss management via Parabolic SAR.</p>

  <div class="risk-card">
    <div class="risk-item"><div class="value">3 min</div><div class="label">Candle Timeframe</div></div>
    <div class="risk-item"><div class="value">BB+RSI</div><div class="label">Entry Signal</div></div>
    <div class="risk-item"><div class="value">PSAR</div><div class="label">Trailing SL</div></div>
    <div class="risk-item"><div class="value">50 pts</div><div class="label">Max SL Cap</div></div>
  </div>

  <h2>2. Indicators Used</h2>
  <div class="indicator-grid">
    <div class="indicator-card">
      <h4>Bollinger Bands (BB)</h4>
      <p>Measures volatility envelope around price. Entry triggered when price breaks above upper band (CE) or below lower band (PE).</p>
      <span class="param">Period: 20</span>
      <span class="param">StdDev: 1.0</span>
    </div>
    <div class="indicator-card">
      <h4>RSI (Relative Strength Index)</h4>
      <p>Momentum confirmation filter. Ensures price breakout has directional strength before entering.</p>
      <span class="param">Period: 14</span>
      <span class="param">CE &gt; 55</span>
      <span class="param">PE &lt; 45</span>
    </div>
    <div class="indicator-card">
      <h4>Parabolic SAR (PSAR)</h4>
      <p>Dynamic trailing stop-loss. Tightens every candle. Also used for initial SL calculation and reversal detection (SAR flip).</p>
      <span class="param">Step: 0.02</span>
      <span class="param">Max: 0.2</span>
    </div>
    <div class="indicator-card">
      <h4>VIX Filter (Market Regime)</h4>
      <p>Blocks entries when India VIX is too high, avoiding choppy/whipsaw conditions that hurt scalping performance.</p>
      <span class="param">Max: 20</span>
      <span class="param">Strong Only: 16</span>
    </div>
  </div>

  <!-- BB + RSI Chart -->
  <h2>3. How BB + RSI Signal Works</h2>
  <div style="text-align:center; margin: 15px 0;">
    <svg width="520" height="220" viewBox="0 0 520 220">
      <defs>
        <linearGradient id="bbFill2" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#302b63" stop-opacity="0.08"/>
          <stop offset="100%" stop-color="#302b63" stop-opacity="0.02"/>
        </linearGradient>
      </defs>
      <rect x="40" y="10" width="470" height="200" rx="8" fill="#fafbff" stroke="#e0e0f0"/>
      <!-- Y axis labels -->
      <text x="35" y="35" text-anchor="end" fill="#999" font-size="8">Upper BB</text>
      <text x="35" y="105" text-anchor="end" fill="#999" font-size="8">SMA 20</text>
      <text x="35" y="175" text-anchor="end" fill="#999" font-size="8">Lower BB</text>
      <!-- BB bands -->
      <path d="M50,30 Q100,22 150,28 T250,25 T350,32 T450,26 L500,30 L500,175 Q450,182 400,172 T300,178 T200,175 T100,180 L50,175 Z" fill="url(#bbFill2)"/>
      <path d="M50,30 Q100,22 150,28 T250,25 T350,32 T450,26 L500,30" fill="none" stroke="#302b63" stroke-width="1.5" stroke-dasharray="5,3" opacity="0.6"/>
      <path d="M50,175 Q100,180 150,172 T250,178 T350,175 T450,180 L500,175" fill="none" stroke="#302b63" stroke-width="1.5" stroke-dasharray="5,3" opacity="0.6"/>
      <!-- SMA -->
      <path d="M50,100 Q100,95 150,98 T250,95 T350,100 T450,96 L500,98" fill="none" stroke="#a8a8d8" stroke-width="1" stroke-dasharray="3,3"/>
      <!-- Price line -->
      <path d="M50,105 70,98 90,92 110,85 130,70 150,55 170,35 190,30 210,42 230,55 250,70 270,85 290,100 310,110 330,125 350,140 370,160 390,175 410,170 430,155 450,140 470,120 490,105" fill="none" stroke="#1a1a2e" stroke-width="2"/>
      <!-- CE entry zone -->
      <circle cx="190" cy="30" r="12" fill="none" stroke="#4caf50" stroke-width="2" stroke-dasharray="3,2"/>
      <text x="190" y="18" text-anchor="middle" fill="#4caf50" font-size="9" font-weight="bold">BUY CE</text>
      <text x="190" y="56" text-anchor="middle" fill="#4caf50" font-size="7">Close &ge; Upper BB</text>
      <text x="190" y="66" text-anchor="middle" fill="#4caf50" font-size="7">RSI &gt; 55</text>
      <!-- PE entry zone -->
      <circle cx="390" cy="175" r="12" fill="none" stroke="#e53935" stroke-width="2" stroke-dasharray="3,2"/>
      <text x="390" y="195" text-anchor="middle" fill="#e53935" font-size="9" font-weight="bold">BUY PE</text>
      <text x="390" y="155" text-anchor="middle" fill="#e53935" font-size="7">Close &le; Lower BB</text>
      <text x="390" y="145" text-anchor="middle" fill="#e53935" font-size="7">RSI &lt; 45</text>
      <!-- Labels -->
      <text x="505" y="30" fill="#302b63" font-size="8" opacity="0.7">Upper</text>
      <text x="505" y="100" fill="#a8a8d8" font-size="8">SMA</text>
      <text x="505" y="178" fill="#302b63" font-size="8" opacity="0.7">Lower</text>
    </svg>
  </div>
  <div class="footer"><span>SCALP_BB_RSI_V4</span><span>Confidential</span></div>
</div>

<!-- PAGE 3: ENTRY LOGIC -->
<div class="page">
  <div class="page-header">SCALP_BB_RSI_V4 Strategy Guide &mdash; Page 3</div>
  <h2>4. Entry Logic</h2>

  <div class="signal-box signal-long">
    <h3 style="color:#2e7d32;">BUY CE (Bullish Entry)</h3>
    <div class="condition"><span class="icon long-icon">1</span> Candle close <strong>&ge; Bollinger Upper Band</strong> (price breaking above volatility envelope)</div>
    <div class="condition"><span class="icon long-icon">2</span> RSI &gt; <strong>55</strong> (momentum confirmation &mdash; not just a wick)</div>
    <div class="condition"><span class="icon long-icon">3</span> Stop Loss = <strong>tighter of</strong> (Previous candle LOW, PSAR value), capped at 50 pts</div>
    <div class="condition"><span class="icon long-icon">4</span> Select <strong>ATM Call option</strong> based on current NIFTY spot price</div>
  </div>

  <div class="signal-box signal-short">
    <h3 style="color:#c62828;">BUY PE (Bearish Entry)</h3>
    <div class="condition"><span class="icon short-icon">1</span> Candle close <strong>&le; Bollinger Lower Band</strong> (price breaking below volatility envelope)</div>
    <div class="condition"><span class="icon short-icon">2</span> RSI &lt; <strong>45</strong> (bearish momentum confirmation)</div>
    <div class="condition"><span class="icon short-icon">3</span> Stop Loss = <strong>tighter of</strong> (Previous candle HIGH, PSAR value), capped at 50 pts</div>
    <div class="condition"><span class="icon short-icon">4</span> Select <strong>ATM Put option</strong> based on current NIFTY spot price</div>
  </div>

  <h3>Pre-Entry Validations</h3>
  <table class="exit-table">
    <tr><th>Check</th><th>Condition</th><th>Action if Failed</th></tr>
    <tr><td>Market Hours</td><td>9:21 AM &ndash; 2:30 PM IST</td><td>Skip entry</td></tr>
    <tr><td>Candle Warmup</td><td>&ge; 30 candles loaded</td><td>Wait for more data</td></tr>
    <tr><td>Daily Loss Limit</td><td>Day P&L &gt; -&#8377;2,000</td><td>Block all entries for day</td></tr>
    <tr><td>Max Daily Trades</td><td>&lt; 30 trades today</td><td>Block further entries</td></tr>
    <tr><td>SL Pause Cooldown</td><td>2 candles since last SL hit</td><td>Wait for cooldown</td></tr>
    <tr><td>VIX Filter</td><td>India VIX &le; 20</td><td>Block entry (see VIX section)</td></tr>
    <tr><td>No Open Position</td><td>Not already in a trade</td><td>Skip signal</td></tr>
  </table>

  <h2>5. Stop Loss Calculation</h2>
  <div style="text-align:center; margin: 15px 0;">
    <svg width="480" height="180" viewBox="0 0 480 180">
      <rect x="5" y="5" width="470" height="170" rx="8" fill="#f8f9ff" stroke="#e0e0f0"/>
      <!-- Flowchart: SL calculation -->
      <rect x="20" y="30" width="100" height="40" rx="6" fill="#302b63" stroke="none"/>
      <text x="70" y="54" text-anchor="middle" fill="#fff" font-size="9" font-weight="bold">Entry Signal</text>

      <line x1="120" y1="50" x2="150" y2="50" stroke="#302b63" stroke-width="1.5" marker-end="url(#arrow)"/>

      <rect x="150" y="20" width="110" height="25" rx="4" fill="#fff" stroke="#302b63"/>
      <text x="205" y="37" text-anchor="middle" fill="#302b63" font-size="8">Prev Candle Low/High</text>

      <rect x="150" y="55" width="110" height="25" rx="4" fill="#fff" stroke="#302b63"/>
      <text x="205" y="72" text-anchor="middle" fill="#302b63" font-size="8">PSAR Value</text>

      <line x1="260" y1="35" x2="290" y2="50" stroke="#302b63" stroke-width="1"/>
      <line x1="260" y1="67" x2="290" y2="50" stroke="#302b63" stroke-width="1"/>

      <rect x="290" y="30" width="80" height="40" rx="20" fill="#00d2ff" stroke="none"/>
      <text x="330" y="47" text-anchor="middle" fill="#0f0c29" font-size="8" font-weight="bold">Pick Tighter</text>
      <text x="330" y="58" text-anchor="middle" fill="#0f0c29" font-size="7">(closer to entry)</text>

      <line x1="370" y1="50" x2="400" y2="50" stroke="#302b63" stroke-width="1.5"/>

      <rect x="400" y="30" width="60" height="40" rx="6" fill="#e53935" stroke="none"/>
      <text x="430" y="47" text-anchor="middle" fill="#fff" font-size="8" font-weight="bold">Cap at</text>
      <text x="430" y="58" text-anchor="middle" fill="#fff" font-size="9" font-weight="bold">50 pts</text>

      <!-- Example -->
      <rect x="20" y="100" width="440" height="55" rx="6" fill="#e8f5e9" stroke="#81c784"/>
      <text x="30" y="118" fill="#2e7d32" font-size="9" font-weight="bold">Example (CE Entry at 22,500):</text>
      <text x="30" y="132" fill="#333" font-size="8.5">Prev Candle Low = 22,465 &rarr; SL distance = 35 pts</text>
      <text x="30" y="144" fill="#333" font-size="8.5">PSAR = 22,470 &rarr; SL distance = 30 pts &rarr; Pick PSAR (tighter) &rarr; Final SL = 22,470 (30 pts)</text>

      <defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" fill="#302b63"/></marker></defs>
    </svg>
  </div>
  <div class="footer"><span>SCALP_BB_RSI_V4</span><span>Confidential</span></div>
</div>

<!-- PAGE 4: EXIT LOGIC -->
<div class="page">
  <div class="page-header">SCALP_BB_RSI_V4 Strategy Guide &mdash; Page 4</div>
  <h2>6. Exit Logic</h2>
  <p>Exits are evaluated on every candle in the following priority order:</p>

  <table class="exit-table">
    <tr><th>Priority</th><th>Exit Type</th><th>Trigger Condition</th><th>Details</th></tr>
    <tr><td><span class="priority">P1</span></td><td><strong>PSAR Stop Loss</strong></td><td>Price crosses SL level</td><td>Initial SL from entry; tightens every candle (never widens). CE: SL moves up. PE: SL moves down.</td></tr>
    <tr><td><span class="priority">P2</span></td><td><strong>Trailing Profit Lock</strong></td><td>PNL drops below locked level</td><td>Activates at &#8377;300 peak profit. Locks in steps of &#8377;200 (300, 500, 700, 900...)</td></tr>
    <tr><td><span class="priority">P3</span></td><td><strong>SAR Flip (Reversal)</strong></td><td>PSAR crosses to opposite side</td><td>Indicates trend reversal. Immediate exit regardless of P&L.</td></tr>
    <tr><td><span class="priority">P4</span></td><td><strong>EOD Square-off</strong></td><td>Time = 3:20 PM IST</td><td>All open positions closed. No new entries after 2:30 PM.</td></tr>
  </table>

  <h3>PSAR Trailing Stop Loss Visualization</h3>
  <div style="text-align:center; margin: 12px 0;">
    <svg width="500" height="200" viewBox="0 0 500 200">
      <rect x="5" y="5" width="490" height="190" rx="8" fill="#fafbff" stroke="#e0e0f0"/>
      <!-- Axis -->
      <line x1="50" y1="170" x2="480" y2="170" stroke="#ccc" stroke-width="1"/>
      <text x="265" y="190" text-anchor="middle" fill="#999" font-size="8">Time (3-min candles)</text>

      <!-- Price going up (CE trade) -->
      <polyline points="60,140 90,130 120,115 150,100 180,85 210,75 240,65 270,70 300,80 330,72 360,60 390,55 420,62 450,70" fill="none" stroke="#1a1a2e" stroke-width="2"/>

      <!-- PSAR dots (below price for CE, tightening) -->
      <circle cx="60" cy="155" r="3" fill="#e53935"/>
      <circle cx="90" cy="148" r="3" fill="#e53935"/>
      <circle cx="120" cy="138" r="3" fill="#e53935"/>
      <circle cx="150" cy="125" r="3" fill="#e53935"/>
      <circle cx="180" cy="110" r="3" fill="#e53935"/>
      <circle cx="210" cy="98" r="3" fill="#e53935"/>
      <circle cx="240" cy="88" r="3" fill="#e53935"/>
      <circle cx="270" cy="85" r="3" fill="#e53935"/>
      <circle cx="300" cy="88" r="3" fill="#e53935"/>
      <circle cx="330" cy="88" r="3" fill="#e53935"/>
      <circle cx="360" cy="82" r="3" fill="#e53935"/>
      <circle cx="390" cy="75" r="3" fill="#e53935"/>
      <!-- SAR flips above -->
      <circle cx="420" cy="52" r="3" fill="#4caf50"/>
      <circle cx="450" cy="58" r="3" fill="#4caf50"/>

      <!-- Entry marker -->
      <line x1="60" y1="140" x2="60" y2="160" stroke="#4caf50" stroke-width="1" stroke-dasharray="2,2"/>
      <text x="60" y="168" text-anchor="middle" fill="#4caf50" font-size="7" font-weight="bold">ENTRY</text>

      <!-- SL tightening annotation -->
      <path d="M75,155 Q170,165 200,98" fill="none" stroke="#e53935" stroke-width="0.8" stroke-dasharray="2,2"/>
      <text x="160" y="150" fill="#e53935" font-size="7" transform="rotate(-25,160,150)">SL tightens &#8593;</text>

      <!-- SAR flip exit -->
      <line x1="420" y1="52" x2="420" y2="65" stroke="#ff9800" stroke-width="1.5"/>
      <rect x="405" y="28" width="55" height="20" rx="4" fill="#ff9800"/>
      <text x="432" y="42" text-anchor="middle" fill="#fff" font-size="8" font-weight="bold">SAR FLIP</text>
      <text x="432" y="17" text-anchor="middle" fill="#ff9800" font-size="7">EXIT HERE</text>

      <!-- Legend -->
      <circle cx="70" cy="22" r="3" fill="#1a1a2e"/>
      <text x="80" y="25" fill="#333" font-size="8">Price</text>
      <circle cx="130" cy="22" r="3" fill="#e53935"/>
      <text x="140" y="25" fill="#333" font-size="8">PSAR (SL)</text>
      <circle cx="210" cy="22" r="3" fill="#4caf50"/>
      <text x="220" y="25" fill="#333" font-size="8">SAR Flipped</text>
    </svg>
  </div>

  <h3>Trailing Profit Lock Mechanism</h3>
  <div class="trail-example">
    <p><strong>How it works:</strong> Once peak unrealized P&L crosses &#8377;300, profit locking activates. It locks in steps of &#8377;200.</p>
    <div style="margin-top:10px;">
      <svg width="440" height="120" viewBox="0 0 440 120">
        <rect x="5" y="5" width="430" height="110" rx="6" fill="#fff" stroke="#e0e0f0"/>
        <!-- P&L curve -->
        <polyline points="30,90 60,75 90,55 120,40 150,30 180,20 210,25 240,35 270,28 300,18 330,22 360,30 390,40 410,50" fill="none" stroke="#302b63" stroke-width="2"/>

        <!-- Lock levels -->
        <line x1="30" y1="65" x2="420" y2="65" stroke="#4caf50" stroke-width="0.8" stroke-dasharray="4,3"/>
        <text x="425" y="68" fill="#4caf50" font-size="7">&#8377;300</text>

        <line x1="30" y1="45" x2="420" y2="45" stroke="#ff9800" stroke-width="0.8" stroke-dasharray="4,3"/>
        <text x="425" y="48" fill="#ff9800" font-size="7">&#8377;500</text>

        <line x1="30" y1="25" x2="420" y2="25" stroke="#e53935" stroke-width="0.8" stroke-dasharray="4,3"/>
        <text x="425" y="28" fill="#e53935" font-size="7">&#8377;700</text>

        <!-- Peak marker -->
        <circle cx="300" cy="18" r="4" fill="#302b63"/>
        <text x="300" y="12" text-anchor="middle" fill="#302b63" font-size="7" font-weight="bold">Peak &#8377;680</text>

        <!-- Exit trigger -->
        <circle cx="410" cy="50" r="4" fill="#e53935"/>
        <text x="395" y="60" fill="#e53935" font-size="7">EXIT: fell below &#8377;500</text>

        <!-- Activated text -->
        <rect x="115" y="68" width="60" height="14" rx="3" fill="#4caf50"/>
        <text x="145" y="78" text-anchor="middle" fill="#fff" font-size="7">Lock &#8377;300</text>

        <rect x="185" y="48" width="60" height="14" rx="3" fill="#ff9800"/>
        <text x="215" y="58" text-anchor="middle" fill="#fff" font-size="7">Lock &#8377;500</text>
      </svg>
    </div>
    <p style="margin-top:8px; font-size:10px; color:#666;"><strong>Example:</strong> Peak profit reaches &#8377;680 &rarr; locked at &#8377;500 (highest complete step). When P&L drops to &#8377;490 &rarr; EXIT triggered, protecting &#8377;500 profit.</p>
  </div>
  <div class="footer"><span>SCALP_BB_RSI_V4</span><span>Confidential</span></div>
</div>

<!-- PAGE 5: VIX FILTER + RISK + TRADE FLOW -->
<div class="page">
  <div class="page-header">SCALP_BB_RSI_V4 Strategy Guide &mdash; Page 5</div>
  <h2>7. VIX Market Regime Filter</h2>
  <p>The India VIX (volatility index) determines whether market conditions suit scalping. High VIX causes whipsaws that repeatedly trigger stop losses.</p>

  <div class="vix-zones">
    <div class="vix-zone vix-green">
      <strong>VIX &le; 16</strong><br/>ALL signals allowed<br/>
      <span style="font-size:9px;">Calm market, ideal for scalping</span>
    </div>
    <div class="vix-zone vix-yellow">
      <strong>16 &lt; VIX &le; 20</strong><br/>STRONG signals only<br/>
      <span style="font-size:9px;">Elevated volatility, cautious</span>
    </div>
    <div class="vix-zone vix-red">
      <strong>VIX &gt; 20</strong><br/>ALL entries BLOCKED<br/>
      <span style="font-size:9px;">High volatility, too risky</span>
    </div>
  </div>

  <h2>8. Risk Management</h2>
  <div class="risk-card">
    <div class="risk-item"><div class="value">&#8377;2,000</div><div class="label">Max Daily Loss</div></div>
    <div class="risk-item"><div class="value">30</div><div class="label">Max Trades/Day</div></div>
    <div class="risk-item"><div class="value">2</div><div class="label">SL Pause Candles</div></div>
    <div class="risk-item"><div class="value">50 pts</div><div class="label">Hard SL Cap</div></div>
  </div>
  <p><strong>SL Pause:</strong> After a stop loss is hit, the strategy pauses for 2 candles (6 minutes) to avoid re-entering immediately into the same choppy move.</p>

  <h2>9. Complete Trade Flow</h2>
  <div class="flow-diagram">
    <svg width="440" height="370" viewBox="0 0 440 370">
      <!-- Flow boxes -->
      <rect x="150" y="5" width="140" height="30" rx="15" fill="#302b63"/>
      <text x="220" y="24" text-anchor="middle" fill="#fff" font-size="9" font-weight="bold">Market Open 9:15 AM</text>
      <line x1="220" y1="35" x2="220" y2="50" stroke="#302b63" stroke-width="1.5" marker-end="url(#arrow2)"/>

      <rect x="140" y="50" width="160" height="28" rx="6" fill="#f0f4ff" stroke="#302b63"/>
      <text x="220" y="68" text-anchor="middle" fill="#302b63" font-size="8.5">Load 30+ candles (warmup)</text>
      <line x1="220" y1="78" x2="220" y2="93" stroke="#302b63" stroke-width="1.5" marker-end="url(#arrow2)"/>

      <rect x="130" y="93" width="180" height="28" rx="6" fill="#f0f4ff" stroke="#302b63"/>
      <text x="220" y="111" text-anchor="middle" fill="#302b63" font-size="8.5">Every 3-min candle close (9:21+)</text>
      <line x1="220" y1="121" x2="220" y2="136" stroke="#302b63" stroke-width="1.5" marker-end="url(#arrow2)"/>

      <!-- Decision diamond -->
      <polygon points="220,136 300,162 220,188 140,162" fill="#fff" stroke="#302b63" stroke-width="1.5"/>
      <text x="220" y="160" text-anchor="middle" fill="#302b63" font-size="8" font-weight="bold">In Position?</text>
      <text x="220" y="170" text-anchor="middle" fill="#302b63" font-size="7">(open trade)</text>

      <!-- YES branch (left) -->
      <text x="132" y="158" text-anchor="end" fill="#4caf50" font-size="8" font-weight="bold">YES</text>
      <line x1="140" y1="162" x2="60" y2="162" stroke="#4caf50" stroke-width="1.5" marker-end="url(#arrow2)"/>

      <rect x="10" y="180" width="100" height="22" rx="4" fill="#e8f5e9" stroke="#81c784"/>
      <text x="60" y="195" text-anchor="middle" fill="#2e7d32" font-size="7.5">Check PSAR SL hit?</text>

      <rect x="10" y="208" width="100" height="22" rx="4" fill="#e8f5e9" stroke="#81c784"/>
      <text x="60" y="223" text-anchor="middle" fill="#2e7d32" font-size="7.5">Check trail profit lock</text>

      <rect x="10" y="236" width="100" height="22" rx="4" fill="#e8f5e9" stroke="#81c784"/>
      <text x="60" y="251" text-anchor="middle" fill="#2e7d32" font-size="7.5">Check SAR flip?</text>

      <rect x="10" y="264" width="100" height="22" rx="4" fill="#e8f5e9" stroke="#81c784"/>
      <text x="60" y="279" text-anchor="middle" fill="#2e7d32" font-size="7.5">Tighten trailing SL</text>

      <rect x="10" y="292" width="100" height="22" rx="4" fill="#fff3e0" stroke="#ffb74d"/>
      <text x="60" y="307" text-anchor="middle" fill="#e65100" font-size="7.5">EOD 3:20? &rarr; Exit</text>

      <!-- NO branch (right) -->
      <text x="308" y="158" fill="#e53935" font-size="8" font-weight="bold">NO</text>
      <line x1="300" y1="162" x2="380" y2="162" stroke="#e53935" stroke-width="1.5" marker-end="url(#arrow2)"/>

      <rect x="330" y="180" width="100" height="22" rx="4" fill="#fce4ec" stroke="#e57373"/>
      <text x="380" y="195" text-anchor="middle" fill="#c62828" font-size="7.5">Validations pass?</text>

      <rect x="330" y="208" width="100" height="22" rx="4" fill="#fce4ec" stroke="#e57373"/>
      <text x="380" y="223" text-anchor="middle" fill="#c62828" font-size="7.5">VIX filter pass?</text>

      <rect x="330" y="236" width="100" height="22" rx="4" fill="#fce4ec" stroke="#e57373"/>
      <text x="380" y="251" text-anchor="middle" fill="#c62828" font-size="7.5">BB + RSI signal?</text>

      <rect x="330" y="264" width="100" height="22" rx="4" fill="#fce4ec" stroke="#e57373"/>
      <text x="380" y="279" text-anchor="middle" fill="#c62828" font-size="7.5">Calculate SL</text>

      <rect x="330" y="292" width="100" height="22" rx="4" fill="#e53935" stroke="none"/>
      <text x="380" y="307" text-anchor="middle" fill="#fff" font-size="7.5" font-weight="bold">ENTER TRADE</text>

      <!-- Bottom -->
      <line x1="60" y1="314" x2="60" y2="340" stroke="#302b63" stroke-width="1"/>
      <line x1="380" y1="314" x2="380" y2="340" stroke="#302b63" stroke-width="1"/>
      <line x1="60" y1="340" x2="380" y2="340" stroke="#302b63" stroke-width="1"/>
      <line x1="220" y1="340" x2="220" y2="355" stroke="#302b63" stroke-width="1.5" marker-end="url(#arrow2)"/>

      <rect x="150" y="355" width="140" height="24" rx="4" fill="#f0f4ff" stroke="#302b63"/>
      <text x="220" y="371" text-anchor="middle" fill="#302b63" font-size="8">Wait for next candle &rarr; repeat</text>

      <defs><marker id="arrow2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" fill="#302b63"/></marker></defs>
    </svg>
  </div>
  <div class="footer"><span>SCALP_BB_RSI_V4</span><span>Confidential</span></div>
</div>

<!-- PAGE 6: CONFIGURATION -->
<div class="page">
  <div class="page-header">SCALP_BB_RSI_V4 Strategy Guide &mdash; Page 6</div>
  <h2>10. Configuration Parameters</h2>
  <p>All parameters are configurable via <code>.env</code> file or the Settings UI:</p>

  <h3>Core Settings</h3>
  <table class="config-table">
    <tr><th>Parameter</th><th>Default</th><th>Description</th></tr>
    <tr><td>SCALP_ENABLED</td><td>false</td><td>Enable/disable scalp strategy</td></tr>
    <tr><td>SCALP_RESOLUTION</td><td>3</td><td>Candle timeframe in minutes (1/2/3/5)</td></tr>
    <tr><td>SCALP_ENTRY_START</td><td>09:21</td><td>Entry window start time (IST)</td></tr>
    <tr><td>SCALP_ENTRY_END</td><td>14:30</td><td>Entry window end time (IST)</td></tr>
  </table>

  <h3>Indicator Settings</h3>
  <table class="config-table">
    <tr><th>Parameter</th><th>Default</th><th>Description</th></tr>
    <tr><td>SCALP_BB_PERIOD</td><td>20</td><td>Bollinger Bands lookback period</td></tr>
    <tr><td>SCALP_BB_STDDEV</td><td>1.0</td><td>BB standard deviation multiplier</td></tr>
    <tr><td>SCALP_RSI_PERIOD</td><td>14</td><td>RSI calculation period</td></tr>
    <tr><td>SCALP_RSI_CE_THRESHOLD</td><td>55</td><td>RSI threshold for CE entry</td></tr>
    <tr><td>SCALP_RSI_PE_THRESHOLD</td><td>45</td><td>RSI threshold for PE entry</td></tr>
    <tr><td>SCALP_PSAR_STEP</td><td>0.02</td><td>PSAR acceleration step</td></tr>
    <tr><td>SCALP_PSAR_MAX</td><td>0.2</td><td>PSAR max acceleration</td></tr>
    <tr><td>SCALP_MAX_SL_PTS</td><td>50</td><td>Hard cap on stop loss distance (points)</td></tr>
  </table>

  <h3>Profit & Risk Settings</h3>
  <table class="config-table">
    <tr><th>Parameter</th><th>Default</th><th>Description</th></tr>
    <tr><td>SCALP_TRAIL_START</td><td>300</td><td>Trailing profit activation threshold (&#8377;)</td></tr>
    <tr><td>SCALP_TRAIL_STEP</td><td>200</td><td>Trailing profit lock step size (&#8377;)</td></tr>
    <tr><td>SCALP_MAX_DAILY_TRADES</td><td>30</td><td>Maximum trades per day</td></tr>
    <tr><td>SCALP_MAX_DAILY_LOSS</td><td>2000</td><td>Daily loss limit (&#8377;)</td></tr>
    <tr><td>SCALP_SL_PAUSE_CANDLES</td><td>2</td><td>Cooldown candles after SL hit</td></tr>
  </table>

  <h3>VIX Filter Settings</h3>
  <table class="config-table">
    <tr><th>Parameter</th><th>Default</th><th>Description</th></tr>
    <tr><td>VIX_FILTER_ENABLED</td><td>true</td><td>Enable VIX-based market regime filter</td></tr>
    <tr><td>VIX_MAX_ENTRY</td><td>20</td><td>Block ALL entries above this VIX level</td></tr>
    <tr><td>VIX_STRONG_ONLY</td><td>16</td><td>Above this: only strong signals allowed</td></tr>
  </table>

  <h2>11. Operating Modes</h2>
  <div class="indicator-grid">
    <div class="indicator-card">
      <h4>Live Trading</h4>
      <p>Real orders via Fyers API. Uses WebSocket for real-time ticks. Builds 3-min candles from tick data. 1-second option LTP polling.</p>
      <span class="param">scalp.js</span>
    </div>
    <div class="indicator-card">
      <h4>Paper Trading</h4>
      <p>Simulated fills with same WebSocket data and exit logic. No real orders placed. Identical strategy evaluation.</p>
      <span class="param">scalpPaper.js</span>
    </div>
    <div class="indicator-card">
      <h4>Backtesting</h4>
      <p>Historical data from Fyers API. Simulates option pricing with delta (0.55) and theta (10 pts/day). CPR and VIX filters.</p>
      <span class="param">scalpBacktest.js</span>
    </div>
    <div class="indicator-card">
      <h4>Settings UI</h4>
      <p>All thresholds configurable via web-based Settings page. Changes apply immediately without restart.</p>
      <span class="param">Dynamic Config</span>
    </div>
  </div>

  <div style="margin-top: 20px; padding: 16px; background: #f0f4ff; border-radius: 8px; border: 1px solid #d0d4ef;">
    <h3 style="margin-top:0;">Key Design Principles</h3>
    <p><strong>No Fixed Targets:</strong> All exits are dynamic &mdash; SL hits, trailing locks, SAR reversals, or EOD. The strategy lets winners run.</p>
    <p><strong>Tightening-Only SL:</strong> Stop loss can only move closer to price, never relax. This protects gains but may exit early in choppy moves.</p>
    <p><strong>Multi-Layer Safety:</strong> VIX filter + daily loss limit + max trades + SL pause = multiple defensive layers preventing excessive losses.</p>
  </div>
  <div class="footer"><span>SCALP_BB_RSI_V4</span><span>Confidential</span></div>
</div>

</body>
</html>`;

function generateCandles() {
  const candles = [
    [50,120,65,105], [70,108,80,100], [80,95,70,90], [90,80,55,65],
    [100,70,40,50], [110,55,30,35], [120,40,25,30], [130,35,42,40],
    [140,45,55,50], [150,58,70,65], [160,72,85,80], [170,88,100,95],
    [180,102,110,108], [190,108,115,112], [200,110,120,118],
    [210,115,125,120], [220,118,130,128], [230,125,135,130],
    [240,128,140,135], [250,132,145,140], [260,138,150,148],
    [270,145,155,152], [280,148,152,150], [290,140,148,142],
    [300,135,142,138], [310,130,140,135], [320,128,138,132],
    [330,125,135,130], [340,120,132,128], [350,118,130,125],
    [360,115,128,122]
  ];
  let svg = '';
  for (const [x, o, h, c] of candles) {
    const top = Math.min(o, c);
    const bot = Math.max(o, c);
    const color = c > o ? '#4caf50' : '#e53935';
    svg += '<line x1="'+x+'" y1="'+h+'" x2="'+x+'" y2="'+Math.min(o,c)+'" stroke="'+color+'" stroke-width="0.5"/>\n';
    svg += '<rect x="'+(x-3)+'" y="'+top+'" width="6" height="'+Math.max(bot-top, 1)+'" fill="'+color+'" rx="0.5"/>\n';
    svg += '<line x1="'+x+'" y1="'+bot+'" x2="'+x+'" y2="'+Math.max(o,c,h)+'" stroke="'+color+'" stroke-width="0.5"/>\n';
  }
  return svg;
}

(async () => {
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: "networkidle0" });
  await page.pdf({
    path: path.join(__dirname, "Scalping_Strategy_Guide.pdf"),
    format: "A4",
    printBackground: true,
    margin: { top: 0, right: 0, bottom: 0, left: 0 }
  });
  await browser.close();
  console.log("PDF generated: documents/Scalping_Strategy_Guide.pdf");
})();

/**
 * optionChart.js — the traded contract's own price chart, next to the spot chart
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 *
 * Every strategy decides on NIFTY spot but *pays in premium*. A spot chart that
 * shows a clean 40-point move tells you nothing about the contract that actually
 * filled — theta, a widening spread and a delta below 1 all live in the premium,
 * not the index. This module draws that second chart so the option's own path is
 * visible beside the signal that produced it.
 *
 * ── Bars are built from the LTP stream we already receive ────────────────────
 * No broker history call. `optionFeed` already streams the held contract's LTP
 * onto the shared socket, and every engine pushes that price into its state. We
 * tap the same value and fold it into OHLC buckets. That makes this module a
 * pure observer: if it were deleted tomorrow, not one trading decision changes.
 *
 * The consequence, and it is a real one: **the LTP stream only runs while a
 * position is open**. Engines start it on entry and stop it on exit, so the
 * option chart is blank when flat and starts fresh at each entry. It shows the
 * trade, never the run-up before it. That is inherent to building from live
 * ticks, not a gap to be patched later with a silent history fetch.
 *
 * ── No stop-loss line, deliberately ──────────────────────────────────────────
 * Every stop in this repo — initial and trailing — is defined and evaluated in
 * SPOT points. There is no premium-terms stop anywhere in a trade record. A
 * premium SL line could only be produced by converting spot points through an
 * assumed delta, and that number would be a guess drawn as a hard line on a
 * price axis, at the exact place a reader is most likely to trust it. So the
 * option chart carries candles, entry and exit only. Stops stay on the spot
 * chart, where they are actually measured.
 */

const { getBucketStart } = require('./tradeUtils');

/** Bars kept per contract. At 1-minute buckets this is a full session and then some. */
const MAX_BARS = 500;

/** Bucket size for premium bars, in minutes. */
function barMinutes() {
  const v = parseInt(process.env.OPTION_CHART_BAR_MIN || '', 10);
  return Number.isFinite(v) && v >= 1 && v <= 15 ? v : 1;
}

/** Master toggle. Off = every helper here degrades to a no-op / empty payload. */
function isEnabled() {
  return String(process.env.OPTION_CHART_ENABLED ?? 'true').toLowerCase() !== 'false';
}

/**
 * Fold one LTP print into a contract's OHLC buckets.
 *
 * Callers own the store: pass the same object back each tick and it accumulates
 * `{ symbol, bars[], forming }`. Switching symbol resets the series, so a new
 * trade on a different strike never inherits the previous contract's candles.
 *
 * @param {object|null} store — accumulator; a fresh one is returned if null.
 * @param {string} symbol — full option symbol the price belongs to.
 * @param {number} price — the LTP print.
 * @param {number} [atMs] — print time (ms). Defaults to now; passed explicitly
 *   by replay/sim so bars bucket on the simulated clock, not wall time.
 * @returns {object} the store (new or mutated).
 */
function pushLtp(store, symbol, price, atMs) {
  if (!isEnabled()) return store || { symbol: symbol || null, bars: [], forming: null };
  const px = Number(price);
  // A zero/negative/NaN print is a feed artefact, not a tradable premium.
  if (!Number.isFinite(px) || px <= 0) return store || { symbol: symbol || null, bars: [], forming: null };

  let s = store;
  // No store yet, or the contract changed → start a clean series. Carrying bars
  // across strikes would splice two unrelated price scales into one chart.
  if (!s || s.symbol !== symbol) s = { symbol: symbol || null, bars: [], forming: null };

  const bucketSec = Math.floor(getBucketStart(atMs != null ? atMs : Date.now(), barMinutes()) / 1000);

  if (!s.forming || s.forming.time !== bucketSec) {
    // Guard against an out-of-order print re-opening a bucket we already closed.
    if (s.forming && bucketSec < s.forming.time) return s;
    if (s.forming) {
      s.bars.push(s.forming);
      if (s.bars.length > MAX_BARS) s.bars.shift();
    }
    s.forming = { time: bucketSec, open: px, high: px, low: px, close: px };
    return s;
  }

  s.forming.high  = Math.max(s.forming.high, px);
  s.forming.low   = Math.min(s.forming.low, px);
  s.forming.close = px;
  return s;
}

/** Drop everything. Called on exit/reset so the next trade starts clean. */
function reset(store) {
  if (!store) return { symbol: null, bars: [], forming: null };
  store.symbol = null; store.bars = []; store.forming = null;
  return store;
}

/**
 * Build the `optionChart` payload for a route's /status/chart-data response.
 *
 * Emitted as a SIBLING key — top-level `candles`/`markers` stay spot, because
 * eodChartReporter reads those off every strategy and must keep seeing spot.
 *
 * Markers are stamped at premium-bar resolution from the trade's own option
 * prices. Trades' `entryBarTime`/`exitBarTime` are SPOT buckets (3m, 5m, 15m…)
 * and would land in the wrong place on a 1-minute premium axis, so they are
 * re-bucketed here from the trade's entry/exit timestamps.
 *
 * @param {object} opts
 * @param {object|null} opts.store — accumulator fed by pushLtp.
 * @param {object|null} opts.position — the open position, if any.
 * @param {Array}  [opts.trades] — session trades, for entry/exit markers.
 * @returns {object|null} payload, or null when there is nothing to draw.
 */
function buildPayload({ store, position, trades } = {}) {
  if (!isEnabled()) return null;
  if (!store || !store.symbol) return null;

  const bars = store.bars.slice();
  if (store.forming && (!bars.length || store.forming.time > bars[bars.length - 1].time)) {
    bars.push(store.forming);
  }
  if (!bars.length) return null;

  const resMin = barMinutes();
  const bucket = (ts) => {
    const ms = typeof ts === 'number' ? (ts < 1e12 ? ts * 1000 : ts) : Date.parse(ts);
    return Number.isFinite(ms) ? Math.floor(getBucketStart(ms, resMin) / 1000) : null;
  };

  // Only this contract's own trades. A session may rotate through several
  // strikes; another strike's fill has no meaning on this price axis.
  const markers = [];
  for (const t of (trades || [])) {
    if (!t || t.symbol !== store.symbol) continue;
    const eT = bucket(t.entryTime || t.entryBarTime);
    if (eT != null && t.optionEntryLtp != null) {
      markers.push({ time: eT, position: 'belowBar', color: '#3b82f6', shape: 'arrowUp',
        text: 'BUY ' + Number(t.optionEntryLtp).toFixed(2) });
    }
    const xT = bucket(t.exitTime || t.exitBarTime);
    if (xT != null && t.optionExitLtp != null) {
      const win = (t.pnl || 0) >= 0;
      markers.push({ time: xT, position: 'aboveBar', color: win ? '#10b981' : '#ef4444', shape: 'arrowDown',
        text: 'EXIT ' + Number(t.optionExitLtp).toFixed(2) });
    }
  }
  markers.sort((a, b) => a.time - b.time);

  const held = !!(position && position.symbol === store.symbol);

  return {
    symbol: store.symbol,
    bars,
    markers,
    held,
    // Entry premium is a real recorded fill, so it earns a line. No stop line —
    // see the header note; premium stops do not exist in this codebase.
    entry: held && position.optionEntryLtp != null ? position.optionEntryLtp : null,
    ltp: bars[bars.length - 1].close,
    barMin: resMin,
  };
}

/** Container markup. `id` must be unique per page. */
function optionChartHtml(id = 'option-chart') {
  if (!isEnabled()) return '';
  return `
<div class="opt-chart-wrap" style="margin-top:14px;">
  <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;margin-bottom:6px;">
    <div style="font-size:0.8rem;color:#8ba1c2;font-family:'IBM Plex Mono',monospace;">
      OPTION <span id="${id}-label" style="color:#e2e8f0;">— no open contract —</span>
    </div>
    <div style="font-size:0.68rem;color:#5b6b85;">premium ticks · entry/exit only · stops shown on spot chart</div>
  </div>
  <div id="${id}-container" style="background:#0a0f1c;border:1px solid #1a2236;border-radius:12px;overflow:hidden;position:relative;height:260px;">
    <div id="${id}" style="width:100%;height:100%;"></div>
    <div id="${id}-empty" style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#5b6b85;font-size:0.75rem;text-align:center;padding:0 16px;font-family:'IBM Plex Mono',monospace;">
      No option candles yet — the premium feed runs only while a position is open.
    </div>
  </div>
</div>`;
}

/**
 * Client script. Reads `optionChart` off the SAME /status/chart-data response
 * the spot chart already polls, so this adds no extra request.
 *
 * @param {object} opts
 * @param {string} opts.dataUrl — the route's chart-data URL.
 * @param {string} [opts.id] — must match optionChartHtml's id.
 * @param {number} [opts.pollMs] — poll interval; matches spot charts by default.
 */
function optionChartScript({ dataUrl, id = 'option-chart', pollMs = 4000 } = {}) {
  if (!isEnabled()) return '';
  return `
<script>
(function() {
  if (typeof LightweightCharts === 'undefined' || '${process.env.CHART_ENABLED}' === 'false') return;
  var el = document.getElementById('${id}');
  var empty = document.getElementById('${id}-empty');
  var label = document.getElementById('${id}-label');
  if (!el) return;
  var chart = LightweightCharts.createChart(el, {
    width: el.clientWidth, height: el.clientHeight,
    layout:{ background:{type:'solid',color:'#0a0f1c'}, textColor:'#8ba1c2', fontSize:11, fontFamily:"'IBM Plex Mono', monospace" },
    grid:{ vertLines:{color:'#111827'}, horzLines:{color:'#111827'} },
    crosshair:{ mode: LightweightCharts.CrosshairMode.Normal },
    rightPriceScale:{ borderColor:'#1a2236' },
    timeScale:{ borderColor:'#1a2236', timeVisible:true, secondsVisible:false,
      tickMarkFormatter:function(t){ var d=new Date(t*1000); return ('0'+d.getHours()).slice(-2)+':'+('0'+d.getMinutes()).slice(-2); } }
  });
  // No indicator overlays here by design — the signal is read off spot; this
  // panel exists to show what the premium actually did.
  var cs = chart.addCandlestickSeries({ upColor:'#10b981', downColor:'#ef4444', borderUpColor:'#10b981', borderDownColor:'#ef4444', wickUpColor:'#10b981', wickDownColor:'#ef4444' });
  var entryLine = null, lastSym = null;

  async function fetchOptChart(){
    try {
      var r = await fetch('${dataUrl}', { cache:'no-store' });
      var d = await r.json();
      var o = d && d.optionChart;
      if (!o || !o.bars || !o.bars.length) {
        if (empty) empty.style.display = 'flex';
        if (label) label.textContent = '— no open contract —';
        return;
      }
      // New contract → clear the previous strike's series and markers outright.
      if (o.symbol !== lastSym) {
        lastSym = o.symbol;
        cs.setMarkers([]);
        if (entryLine) { try { cs.removePriceLine(entryLine); } catch(_){} entryLine = null; }
      }
      if (empty) empty.style.display = 'none';
      if (label) label.textContent = o.symbol + '  \\u20b9' + Number(o.ltp).toFixed(2) + (o.held ? '  \\u25cf HOLDING' : '  (closed)');
      cs.setData(o.bars);
      cs.setMarkers(o.markers && o.markers.length ? o.markers : []);
      if (entryLine) { try { cs.removePriceLine(entryLine); } catch(_){} entryLine = null; }
      if (o.entry != null && isFinite(o.entry)) {
        entryLine = cs.createPriceLine({ price:o.entry, color:'#3b82f6', lineWidth:1,
          lineStyle:LightweightCharts.LineStyle.Dotted, axisLabelVisible:true, title:'Entry' });
      }
    } catch(e) {}
  }
  fetchOptChart();
  setInterval(fetchOptChart, ${pollMs});
  window.addEventListener('resize', function(){ try { chart.applyOptions({ width: el.clientWidth }); } catch(_){} });
})();
</script>`;
}

module.exports = {
  isEnabled,
  barMinutes,
  pushLtp,
  reset,
  buildPayload,
  optionChartHtml,
  optionChartScript,
  MAX_BARS,
};

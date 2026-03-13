// Quick unit test: simulate what backtest does — does OR reset per day?
process.env.TZ = 'Asia/Kolkata';

const strategy = require('/home/claude/trading-app-v19/src/strategies/strategy2_15min_orb.js');

// Make fake candles: 2 days, 15-min, 9:15 to 15:30 = 26 candles/day
function makeCandle(dateStr, hourMin, open, high, low, close) {
  const [h, m] = hourMin.split(':').map(Number);
  const d = new Date(`${dateStr}T${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:00+05:30`);
  return { time: Math.floor(d.getTime()/1000), open, high, low, close, volume: 1000 };
}

// Day 1: Jan 30, ranging day — OR=24900-25100, then breakdowns
// Day 2: Jan 31 — completely different OR
const candles = [];

// Day 1 candles — OR candles (9:15 to 10:00)
const d1 = '2026-01-30';
candles.push(makeCandle(d1, '9:15',  25000, 25100, 24900, 25050)); // OR candle 1
candles.push(makeCandle(d1, '9:30',  25050, 25080, 24950, 25000)); // OR candle 2
candles.push(makeCandle(d1, '9:45',  25000, 25060, 24920, 24960)); // OR candle 3
candles.push(makeCandle(d1, '10:00', 24960, 25010, 24880, 24950)); // OR candle 4
// Post-OR trading candles with big moves
candles.push(makeCandle(d1, '10:15', 24950, 24960, 24700, 24720)); // strong breakdown!
candles.push(makeCandle(d1, '10:30', 24720, 24750, 24600, 24620));
candles.push(makeCandle(d1, '10:45', 24620, 24650, 24550, 24560));
// ... fill up to 25 candles for Day 1
for (let m = 11*60; m < 15*60+30; m+=15) {
  const h = Math.floor(m/60), mi = m%60;
  candles.push(makeCandle(d1, `${h}:${String(mi).padStart(2,'0')}`, 24560, 24600, 24500, 24520));
}

// Day 2 candles — completely different price level
const d2 = '2026-01-31';
candles.push(makeCandle(d2, '9:15',  25200, 25350, 25150, 25300)); // OR candle 1 day2
candles.push(makeCandle(d2, '9:30',  25300, 25380, 25250, 25350)); // OR candle 2 day2
candles.push(makeCandle(d2, '9:45',  25350, 25400, 25280, 25300)); // OR candle 3 day2
candles.push(makeCandle(d2, '10:00', 25300, 25360, 25220, 25250)); // OR candle 4 day2
candles.push(makeCandle(d2, '10:15', 25250, 25260, 24900, 24850)); // strong breakdown day2!
candles.push(makeCandle(d2, '10:30', 24850, 24880, 24750, 24760));

console.log(`Total candles: ${candles.length}`);

// Simulate backtest loop
let prevDate = null;
for (let i = 4; i < candles.length; i++) {
  const window = candles.slice(0, i+1);
  const result = strategy.getSignal(window);
  const c = candles[i];
  const d = new Date(c.time*1000).toLocaleDateString('en-CA', {timeZone:'Asia/Kolkata'});
  const t = new Date(c.time*1000).toLocaleTimeString('en-IN', {timeZone:'Asia/Kolkata', hour12:false});
  
  if (d !== prevDate) {
    console.log(`\n=== ${d} ===`);
    prevDate = d;
  }
  
  if (result.signal !== 'NONE') {
    console.log(`  SIGNAL @ ${t}: ${result.signal} | orHigh=${result.orHigh} orLow=${result.orLow}`);
  } else if (result.orHigh) {
    // Log OR info to verify reset
    if (t === '10:15:00' || t === '10:00:00') {
      console.log(`  OR @ ${t}: H=${result.orHigh} L=${result.orLow} range=${result.orRange} | ${result.reason?.substring(0,60)}`);
    }
  }
}

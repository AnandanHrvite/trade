/**
 * Deterministic synthetic OHLCV for scanner tests. No RNG from Math.random —
 * a seeded LCG, so a failing case is always reproducible.
 */
function lcg(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

// 09:15 IST on the Monday at least `n` sessions before today, so a fixture
// series lands inside the date window the scanner actually requests.
const istDayKeyOf = t => Math.floor((t + 19800) / 86400);
function mondayBefore(days) {
  let dk = istDayKeyOf(Math.floor(Date.now() / 1000)) - days;
  while (((dk + 4) % 7) !== 1) dk--;          // walk back to a Monday
  return dk * 86400 - 19800 + (9 * 3600 + 15 * 60);   // 09:15 IST that day
}
const BASE = mondayBefore(400);
const istDayKey = t => Math.floor((t + 19800) / 86400);
const istWeekday = t => (istDayKey(t) + 4) % 7;

/** Hourly NSE bars (7 per session) over `sessions` trading days. */
function hourly({ sessions = 80, start = 1000, drift = 0, vol = 0.006, seed = 42, volBase = 200000 } = {}) {
  const rnd = lcg(seed);
  const out = [];
  let p = start, d = 0, made = 0;
  while (made < sessions) {
    const t0 = BASE + d * 86400;
    if (istWeekday(t0) === 0 || istWeekday(t0) === 6) { d++; continue; }
    for (let b = 0; b < 7; b++) {
      const mins = b * 60;
      if (mins >= 375) break;
      const open = p;
      const shock = (rnd() - 0.5) * 2 * vol * p;
      p = Math.max(1, p + drift * p + shock);
      const close = p;
      const wick = Math.abs(shock) * (0.3 + rnd() * 0.7);
      out.push({
        time: t0 + mins * 60,
        open, close,
        high: Math.max(open, close) + wick,
        low:  Math.max(0.5, Math.min(open, close) - wick),
        volume: Math.round(volBase * (0.5 + rnd() * 1.5)),
      });
    }
    made++; d++;
  }
  return out;
}

/** Daily NSE bars stamped 00:00 IST, the way Fyers returns 1D. */
function daily({ sessions = 200, start = 1000, drift = 0, vol = 0.015, seed = 7, volBase = 1500000 } = {}) {
  const rnd = lcg(seed);
  const out = [];
  let p = start, d = 0, made = 0;
  while (made < sessions) {
    const t0 = BASE + d * 86400;
    if (istWeekday(t0) === 0 || istWeekday(t0) === 6) { d++; continue; }
    const open = p;
    const shock = (rnd() - 0.5) * 2 * vol * p;
    p = Math.max(1, p + drift * p + shock);
    const close = p;
    const wick = Math.abs(shock) * (0.4 + rnd());
    out.push({
      time: istDayKey(t0) * 86400 - 19800,          // 00:00 IST
      open, close,
      high: Math.max(open, close) + wick,
      low:  Math.max(0.5, Math.min(open, close) - wick),
      volume: Math.round(volBase * (0.5 + rnd() * 1.5)),
    });
    made++; d++;
  }
  return out;
}

/** A double-bottom into a breakout — the shape PA is built to find. */
function doubleBottom({ start = 1000, seed = 3 } = {}) {
  const rnd = lcg(seed);
  const out = [];
  let d = 0, made = 0, idx = 0;
  // price path: drift down, bottom, bounce, back to bottom, then break the neckline
  const path = [];
  for (let i = 0; i < 40; i++) path.push(start - i * 4);          // decline to 844
  for (let i = 0; i < 14; i++) path.push(844 + i * 6);            // bounce to 928 (neckline)
  for (let i = 0; i < 14; i++) path.push(928 - i * 6);            // back down to 844
  for (let i = 0; i < 30; i++) path.push(844 + i * 5);            // rally through 928
  for (let i = 0; i < 20; i++) path.push(994 + i * 1);            // hold above
  while (idx < path.length) {
    const t0 = BASE + d * 86400;
    if (istWeekday(t0) === 0 || istWeekday(t0) === 6) { d++; continue; }
    for (let b = 0; b < 7 && idx < path.length; b++, idx++) {
      const open = idx === 0 ? path[0] : path[idx - 1];
      const close = path[idx];
      const wick = 2 + rnd() * 3;
      out.push({
        time: t0 + b * 3600, open, close,
        high: Math.max(open, close) + wick,
        low:  Math.min(open, close) - wick,
        volume: Math.round(200000 * (0.5 + rnd())),
      });
    }
    made++; d++;
  }
  return out;
}

module.exports = { hourly, daily, doubleBottom, lcg, BASE, istDayKey, istWeekday };

/**
 * A bullish order-block retest PA can trade, on a ~₹900 stock. Moves are tiny
 * because the scanner scales PA's point settings down to the share price.
 * Ends ON the reaction candle, which is the bar PA enters on.
 */
function paOrderBlockSetup() {
  const s = p => 900 + (p - 1000) * 0.03;
  const rows = require('./priceActionSmc.fixture').bullBars().map(r => r.map(s));
  const out = [];
  let d = 0, idx = 0;
  while (idx < rows.length) {
    const t0 = BASE + d * 86400;
    if (istWeekday(t0) === 0 || istWeekday(t0) === 6) { d++; continue; }
    for (let b = 0; b < 7 && idx < rows.length; b++, idx++) {
      const [o, h, l, c] = rows[idx];
      out.push({ time: t0 + b * 3600, open: o, high: h, low: l, close: c, volume: 250000 });
    }
    d++;
  }
  return out;
}

module.exports.paOrderBlockSetup = paOrderBlockSetup;
